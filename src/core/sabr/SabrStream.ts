/**
 * Transport for SABR: posts `VideoPlaybackAbrRequest`s and feeds the UMP
 * responses through a {@link SabrProcessor}.
 *
 * Ported from SmartTube's `parser/SabrStream.java` (Apache-2.0).
 *
 * One round trip does not deliver one segment. The server answers each request
 * with as much media as its own policy allows — measured, roughly 780 KB across
 * both tracks — so a stream is a sequence of requests whose progress is carried
 * in the request body. `segments()` runs that loop.
 *
 * **Response reading.** `fetch` on React Native resolves without a readable
 * `body`, so the streaming path is used when available and the whole response is
 * buffered otherwise. Either way the decoder sees the same byte sequence.
 */
import type { FormatId } from '../../../protos/generated/sabr/misc/common.js';
import type { StreamerContext_ClientInfo } from '../../../protos/generated/sabr/videostreaming/streamer_context.js';
import { StreamerContext_ClientName } from '../../../protos/generated/sabr/videostreaming/streamer_context.js';

import * as Constants from '../../utils/Constants.js';
import * as Log from '../../utils/Log.js';
import { base64ToU8, InnertubeError, Platform } from '../../utils/Utils.js';
import { SabrError, SabrProcessor } from './SabrProcessor.js';
import { UmpDecoder } from './UmpDecoder.js';

import type { FetchFunction } from '../../types/index.js';
import type { SabrFormat, SabrProtectionStatus, SabrSegment } from './SabrProcessor.js';

const TAG_ = 'SabrStream';

/**
 * InnerTube client name to the `StreamerContext.ClientName` enum.
 *
 * The enum is not the InnerTube name: `TV_SIMPLY` is `TVHTML5_SIMPLY`, `TV` is
 * `TVHTML5`. Plan §0c measured 403 for `TV_SIMPLY` and `WEB`; re-measured on
 * 2026-10-04 that came from the unsolved `n` challenge in their URL. Deciphered,
 * both are served — but only `VISIONOS` stays at `OK` without a PoToken.
 */
export const SABR_CLIENT_NAMES: Record<string, number> = {
  WEB: StreamerContext_ClientName.WEB,
  MWEB: StreamerContext_ClientName.MWEB,
  ANDROID: StreamerContext_ClientName.ANDROID,
  ANDROID_VR: StreamerContext_ClientName.ANDROID_VR,
  IOS: StreamerContext_ClientName.IOS,
  VISIONOS: StreamerContext_ClientName.VISIONOS,
  TV: StreamerContext_ClientName.TVHTML5,
  TV_SIMPLY: StreamerContext_ClientName.TVHTML5_SIMPLY,
  TV_EMBEDDED: StreamerContext_ClientName.TVHTML5,
  WEB_EMBEDDED: StreamerContext_ClientName.WEB_EMBEDDED_PLAYER
};

export interface SabrStreamOptions {
  /**
   * `streaming_data.server_abr_streaming_url`, with its `n` challenge solved —
   * pass it through `Player#decipher` first. Clients whose URL carries an `n`
   * parameter (measured: `WEB`) get HTTP 403 for the raw URL.
   */
  server_abr_streaming_url: string;
  /**
   * `player_config.media_common_config.media_ustreamer_request_config
   * .video_playback_ustreamer_config`, still base64.
   */
  ustreamer_config: string;
  /** InnerTube client the player response came from, e.g. `VISIONOS`. */
  client_name: string;
  client_version: string;
  video_format_id?: FormatId;
  audio_format_id?: FormatId;
  video_id?: string;
  /**
   * Websafe-base64 PoToken bound to the video id. Measured: `WEB` stays at
   * `ATTESTATION_PENDING` without one and turns `ATTESTATION_REQUIRED` after a
   * seek; with a content-bound token it reports `OK` throughout.
   */
  po_token?: string;
  start_time_ms?: number;
  /** Narrow to one track; defaults to video and audio together. */
  enabled_track_types?: number;
  fetch?: FetchFunction;
  /** Round trips before `segments()` gives up. Guards against a stuck server. */
  max_requests?: number;
}

export interface SabrRequestResult {
  http_status: number;
  request_bytes: number;
  response_bytes: number;
  /**
   * `true` when the response body was read incrementally, `false` when it had to
   * be buffered whole because the platform's `fetch` gave no readable stream.
   */
  streamed: boolean;
  formats: SabrFormat[];
  segments: SabrSegment[];
}

/**
 * A server that answers but sends nothing this many times in a row is not going
 * to start. Two is deliberate: one empty response is normal right at the end of
 * a track, two means progress has stopped.
 */
const MAX_EMPTY_RESPONSES = 2;

export class SabrStream {
  readonly #processor: SabrProcessor;
  readonly #options: SabrStreamOptions;
  readonly #ustreamer_config: Uint8Array;
  readonly #client_info: StreamerContext_ClientInfo;
  readonly #fetch: FetchFunction;
  readonly #max_requests: number;

  #url: string;
  #request_number = 0;
  #last_response_streamed?: boolean;

  constructor(options: SabrStreamOptions) {
    if (!options.server_abr_streaming_url)
      throw new InnertubeError('SABR needs a server_abr_streaming_url. The player response did not carry one.');

    if (!options.ustreamer_config)
      throw new InnertubeError('SABR needs a video_playback_ustreamer_config. The player response did not carry one.');

    if (!options.video_format_id && !options.audio_format_id)
      throw new InnertubeError('SABR needs at least one format to request');

    const client_name = SABR_CLIENT_NAMES[options.client_name];

    if (client_name === undefined)
      throw new InnertubeError(`No StreamerContext client name known for ${options.client_name}`);

    this.#options = options;
    this.#url = options.server_abr_streaming_url;
    this.#ustreamer_config = base64ToU8(options.ustreamer_config);
    this.#fetch = options.fetch ?? Platform.shim.fetch;
    this.#max_requests = options.max_requests ?? 256;

    this.#client_info = {
      clientName: client_name,
      clientVersion: options.client_version
    };

    this.#processor = new SabrProcessor({
      video_id: options.video_id,
      po_token: options.po_token,
      start_time_ms: options.start_time_ms
    });
  }

  get formats(): SabrFormat[] {
    return this.#processor.formats;
  }

  get protection_status(): SabrProtectionStatus {
    return this.#processor.protection_status;
  }

  get player_time_ms(): number {
    return this.#processor.player_time_ms;
  }

  /** Part types the server sent that this implementation does not know. */
  get unknown_parts(): string[] {
    return [ ...this.#processor.unknown_parts ];
  }

  /**
   * How the last response body was read, or `undefined` before the first
   * request. `false` means the platform buffered it whole — the normal case on
   * React Native, and worth knowing because it bounds peak memory per request.
   */
  get last_response_streamed(): boolean | undefined {
    return this.#last_response_streamed;
  }

  seek(time_ms: number): void {
    this.#processor.seek(time_ms);
  }

  /** One round trip: build the request, post it, process every part it returns. */
  async requestNext(): Promise<SabrRequestResult> {
    // Copied into a fresh Uint8Array so its buffer type satisfies `BodyInit`;
    // the request is ~1.5 KB, so the copy is not worth avoiding.
    const body = new Uint8Array(this.#processor.buildRequest({
      ustreamer_config: this.#ustreamer_config,
      client_info: this.#client_info,
      video_format_id: this.#options.video_format_id,
      audio_format_id: this.#options.audio_format_id,
      enabled_track_types: this.#options.enabled_track_types
    }));

    // `rn` is the request number; the server rejects a replayed one.
    const url = new URL(this.#url);
    url.searchParams.set('rn', String(++this.#request_number));

    const response = await this.#fetch(url.toString(), {
      method: 'POST',
      headers: {
        ...Constants.STREAM_HEADERS,
        'content-type': 'application/x-protobuf'
      },
      body
    });

    if (!response.ok) {
      throw new SabrError(
        `SABR request failed: HTTP ${response.status}. ${response.status === 403
          ? 'The URL\'s n challenge may be unsolved (pass it through Player#decipher) or the URL expired.'
          : 'The streaming URL may have expired.'}`
      );
    }

    const decoder = new UmpDecoder();
    let response_bytes = 0;

    const drain = () => {
      for (const part of decoder.parts())
        this.#processor.process(part);
    };

    const reader = response.body?.getReader?.();

    this.#last_response_streamed = !!reader;

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();

        if (done)
          break;

        response_bytes += value.length;
        decoder.push(value);
        drain();
      }
    } else {
      // React Native: no streaming body, so the response is buffered whole.
      const buffer = new Uint8Array(await response.arrayBuffer());
      response_bytes = buffer.length;
      decoder.push(buffer);
      drain();
    }

    if (decoder.pending)
      Log.warn(TAG_, `Response ended mid-part, ${decoder.pending} bytes discarded`);

    if (this.#processor.reload_requested)
      throw new SabrError('Server asked for a fresh player response. Call /player again and start a new stream.');

    const formats = this.#processor.drainFormats();
    const segments = this.#processor.drainSegments();

    // A redirect applies from the next request onwards; the current response is
    // still valid and already processed.
    const redirect = this.#processor.redirect_url;

    if (redirect && redirect !== this.#url) {
      Log.info(TAG_, 'Following SABR redirect');
      this.#url = redirect;
    }

    this.#processor.advance();

    return {
      http_status: response.status,
      request_bytes: body.length,
      response_bytes,
      streamed: !!reader,
      formats,
      segments
    };
  }

  /**
   * Runs the request loop and yields segments as they complete.
   *
   * Ends when every initialized format has reported its last segment, or when
   * the server stops sending media. Respects `backoff_time_ms` between requests.
   */
  async* segments(): AsyncGenerator<SabrSegment> {
    let empty_responses = 0;

    for (let request = 0; request < this.#max_requests; request++) {
      const result = await this.requestNext();

      if (result.segments.length) {
        empty_responses = 0;

        for (const segment of result.segments)
          yield segment;
      } else if (++empty_responses >= MAX_EMPTY_RESPONSES) {
        Log.info(TAG_, 'Server stopped sending media, ending the stream');
        return;
      }

      if (this.#processor.isComplete())
        return;

      if (this.#processor.protection_status === 'required') {
        throw new SabrError(
          'Server requires attestation for this stream. A PoToken is needed (plan phase 2b/5).'
        );
      }

      const backoff = this.#processor.backoff_time_ms;

      if (backoff > 0)
        await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    throw new SabrError(`Gave up after ${this.#max_requests} SABR requests without reaching the end of the stream`);
  }
}
