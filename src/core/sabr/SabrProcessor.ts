/**
 * The SABR protocol state machine.
 *
 * SABR (Server ABR) inverts the usual arrangement: instead of the client asking
 * for a byte range, it posts a `VideoPlaybackAbrRequest` describing where
 * playback stands and what it already holds, and the server answers with a UMP
 * stream of whichever segments it decides to send. Progress therefore lives in
 * the request, not in a URL — this class keeps that state.
 *
 * Ported from SmartTube's `parser/SabrProcessor.java` (Apache-2.0), narrowed to
 * what serving segments needs: on-demand playback of one video and one audio
 * format. Live and Post-Live DVR are detected and rejected rather than
 * half-supported, because their segment numbering only makes sense against a
 * moving head — see `isLive()`.
 *
 * The class is deliberately transport-free. It turns parts into segments and
 * builds the next request body; fetching is `SabrStream`'s job.
 */
import type { FormatId } from '../../../protos/generated/sabr/misc/common.js';
import { UmpPartId } from '../../../protos/generated/sabr/other/ump_part_id.js';
import type { BufferedRange } from '../../../protos/generated/sabr/videostreaming/buffered_range.js';
import type { ClientAbrState } from '../../../protos/generated/sabr/videostreaming/client_abr_state.js';
import { FormatInitializationMetadata } from '../../../protos/generated/sabr/videostreaming/format_initialization_metadata.js';
import { LiveMetadata } from '../../../protos/generated/sabr/videostreaming/live_metadata.js';
import { MediaHeader } from '../../../protos/generated/sabr/videostreaming/media_header.js';
import { NextRequestPolicy } from '../../../protos/generated/sabr/videostreaming/next_request_policy.js';
import { PlaybackCookie } from '../../../protos/generated/sabr/videostreaming/playback_cookie.js';
import { SabrContextSendingPolicy } from '../../../protos/generated/sabr/videostreaming/sabr_context_sending_policy.js';
import { SabrContextUpdate, SabrContextUpdate_SabrContextWritePolicy } from '../../../protos/generated/sabr/videostreaming/sabr_context_update.js';
import { SabrError as SabrErrorMessage } from '../../../protos/generated/sabr/videostreaming/sabr_error.js';
import { SabrRedirect } from '../../../protos/generated/sabr/videostreaming/sabr_redirect.js';
import { SabrSeek } from '../../../protos/generated/sabr/videostreaming/sabr_seek.js';
import { StreamProtectionStatus, StreamProtectionStatus_Status } from '../../../protos/generated/sabr/videostreaming/stream_protection_status.js';
import type { StreamerContext, StreamerContext_ClientInfo } from '../../../protos/generated/sabr/videostreaming/streamer_context.js';
import { VideoPlaybackAbrRequest } from '../../../protos/generated/sabr/videostreaming/video_playback_abr_request.js';

import * as Log from '../../utils/Log.js';
import { base64ToU8, InnertubeError } from '../../utils/Utils.js';
import { readUmpVarInt, umpPartName } from './UmpDecoder.js';

import type { UmpPart } from './UmpDecoder.js';

const TAG_ = 'SabrProcessor';

/** `enabled_track_types_bitfield`; mirrors SmartTube's `EnabledTrackTypes`. */
export const EnabledTrackTypes = {
  VIDEO_AND_AUDIO: 0,
  AUDIO_ONLY: 1,
  VIDEO_ONLY: 2
} as const;

/**
 * Parts we knowingly ignore. Listing them keeps `unknown_parts` meaningful: a
 * part showing up there is a protocol change worth looking at, not noise.
 */
const IGNORED_PARTS = new Set<number>([
  UmpPartId.REQUEST_IDENTIFIER,
  UmpPartId.REQUEST_CANCELLATION_POLICY,
  UmpPartId.PLAYBACK_START_POLICY,
  UmpPartId.ALLOWED_CACHED_FORMATS,
  UmpPartId.PAUSE_BW_SAMPLING_HINT,
  UmpPartId.START_BW_SAMPLING_HINT,
  UmpPartId.REQUEST_PIPELINING,
  UmpPartId.SELECTABLE_FORMATS,
  UmpPartId.PREWARM_CONNECTION,
  UmpPartId.TIMELINE_CONTEXT,
  UmpPartId.SABR_ACK,
  UmpPartId.LAWNMOWER_POLICY,
  UmpPartId.LAWNMOWER_MESSAGING_POLICY,
  UmpPartId.CACHE_LOAD_POLICY,
  UmpPartId.PLAYBACK_DEBUG_INFO,
  UmpPartId.SNACKBAR_MESSAGE,
  UmpPartId.END_OF_TRACK
]);

/** Raised for protocol-level failures, so callers can fall back deliberately. */
export class SabrError extends InnertubeError {}

/**
 * Attestation state the server reports through `STREAM_PROTECTION_STATUS`.
 *
 * `ATTESTATION_REQUIRED` is the one that matters operationally: it means the
 * stream needs a PoToken (plan phase 2b/5) and will otherwise dry up.
 */
export type SabrProtectionStatus = 'ok' | 'pending' | 'required' | 'unknown';

export interface SabrFormat {
  /** `itag:xtags`, the key `StreamingInfo` puts into a `sabr://` URL. */
  key: string;
  format_id: FormatId;
  itag: number;
  mime_type?: string;
  /** Total duration in ms, or `-1` when the server did not say. */
  duration_ms: number;
  /** Number of media segments, or `-1` when the server did not say. */
  total_segments: number;
  is_video: boolean;
}

export interface SabrSegment {
  format_key: string;
  /** Sequence number, or `-1` for the initialization segment. */
  sequence_number: number;
  is_init: boolean;
  start_ms: number;
  duration_ms: number;
  data: Uint8Array;
}

/** A range of segments already received, reported back as `buffered_ranges`. */
interface ConsumedRange {
  start_time_ms: number;
  duration_ms: number;
  start_sequence_number: number;
  end_sequence_number: number;
}

interface TrackedFormat extends SabrFormat {
  consumed_ranges: ConsumedRange[];
  /** End of the newest segment received, in ms — drives `player_time_ms`. */
  furthest_end_ms: number;
}

/** A segment being assembled from `MEDIA_HEADER` → `MEDIA`×n → `MEDIA_END`. */
interface PartialSegment {
  format_key: string;
  sequence_number: number;
  is_init: boolean;
  start_ms: number;
  duration_ms: number;
  /** `content_length` from the header, or `-1` when absent. */
  content_length: number;
  chunks: Uint8Array[];
  received: number;
}

export interface SabrProcessorOptions {
  /** Guards against the server answering for a different video. */
  video_id?: string;
  /** Websafe-base64 `pot`, bound to the video id. Goes in as raw bytes. */
  po_token?: string;
  /** Where playback starts, in ms. */
  start_time_ms?: number;
}

export function formatKey(format_id: FormatId): string {
  return `${format_id.itag ?? ''}:${format_id.xtags ?? ''}`;
}

function ticksToMs(ticks?: number, timescale?: number): number {
  if (ticks === undefined || !timescale)
    return -1;
  return Math.round((ticks / timescale) * 1000);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

export class SabrProcessor {
  readonly #video_id?: string;
  readonly #po_token?: Uint8Array;

  /** Formats the server has initialized, by `itag:xtags`. */
  readonly #formats = new Map<string, TrackedFormat>();
  /** Segments under construction, by `header_id`. */
  readonly #partials = new Map<number, PartialSegment>();

  readonly #new_formats: SabrFormat[] = [];
  readonly #new_segments: SabrSegment[] = [];

  readonly #sabr_context_updates = new Map<number, SabrContextUpdate>();
  readonly #sabr_contexts_to_send = new Set<number>();

  #playback_cookie?: PlaybackCookie;
  #next_request_policy?: NextRequestPolicy;
  #live_metadata?: LiveMetadata;

  #player_time_ms: number;
  #redirect_url?: string;
  #protection_status: SabrProtectionStatus = 'unknown';
  #reload_requested = false;

  /** Part types seen that are neither handled nor knowingly ignored. */
  readonly unknown_parts = new Set<string>();

  constructor(options: SabrProcessorOptions = {}) {
    this.#video_id = options.video_id;
    // The PoToken travels as raw bytes in StreamerContext, not as the websafe
    // base64 string that goes into a `&pot=` query parameter.
    this.#po_token = options.po_token ? base64ToU8(options.po_token) : undefined;
    this.#player_time_ms = Math.max(0, options.start_time_ms ?? 0);
  }

  get player_time_ms(): number {
    return this.#player_time_ms;
  }

  /** Where the next request should pick up, once a response is processed. */
  get redirect_url(): string | undefined {
    return this.#redirect_url;
  }

  get protection_status(): SabrProtectionStatus {
    return this.#protection_status;
  }

  /** Server-requested pause before the next request, in ms. */
  get backoff_time_ms(): number {
    return this.#next_request_policy?.backoffTimeMs ?? 0;
  }

  /**
   * `true` once the server asked for a fresh player response. The streaming URL
   * and ustreamer config are then stale and `/player` has to be called again.
   */
  get reload_requested(): boolean {
    return this.#reload_requested;
  }

  isLive(): boolean {
    return !!this.#live_metadata;
  }

  get formats(): SabrFormat[] {
    return [ ...this.#formats.values() ];
  }

  /** Formats initialized since the last call. */
  drainFormats(): SabrFormat[] {
    return this.#new_formats.splice(0, this.#new_formats.length);
  }

  /** Segments completed since the last call. */
  drainSegments(): SabrSegment[] {
    return this.#new_segments.splice(0, this.#new_segments.length);
  }

  /**
   * Feeds one UMP part through the machine.
   *
   * `data` may be a view into a decoder buffer, so anything kept beyond this
   * call is copied here.
   */
  process(part: UmpPart): void {
    switch (part.type) {
      case UmpPartId.MEDIA_HEADER:
        this.#processMediaHeader(MediaHeader.decode(part.data));
        return;
      case UmpPartId.MEDIA:
        this.#processMedia(part.data);
        return;
      case UmpPartId.MEDIA_END:
        this.#processMediaEnd(part.data);
        return;
      case UmpPartId.FORMAT_INITIALIZATION_METADATA:
        this.#processFormatInitializationMetadata(FormatInitializationMetadata.decode(part.data));
        return;
      case UmpPartId.NEXT_REQUEST_POLICY:
        this.#processNextRequestPolicy(NextRequestPolicy.decode(part.data));
        return;
      case UmpPartId.SABR_REDIRECT:
        this.#processSabrRedirect(SabrRedirect.decode(part.data));
        return;
      case UmpPartId.STREAM_PROTECTION_STATUS:
        this.#processStreamProtectionStatus(StreamProtectionStatus.decode(part.data));
        return;
      case UmpPartId.SABR_CONTEXT_UPDATE:
        this.#processSabrContextUpdate(SabrContextUpdate.decode(part.data));
        return;
      case UmpPartId.SABR_CONTEXT_SENDING_POLICY:
        this.#processSabrContextSendingPolicy(SabrContextSendingPolicy.decode(part.data));
        return;
      case UmpPartId.SABR_ERROR:
        this.#processSabrError(SabrErrorMessage.decode(part.data));
        return;
      case UmpPartId.SABR_SEEK:
        this.#processSabrSeek(SabrSeek.decode(part.data));
        return;
      case UmpPartId.LIVE_METADATA:
        this.#live_metadata = LiveMetadata.decode(part.data);
        return;
      case UmpPartId.RELOAD_PLAYER_RESPONSE:
        // The payload carries a reload token we do not use: the caller has to go
        // back to `/player` either way, which yields a fresh streaming URL.
        this.#reload_requested = true;
        Log.warn(TAG_, 'Server asked for a fresh player response');
        return;
      default:
        break;
    }

    if (!IGNORED_PARTS.has(part.type))
      this.unknown_parts.add(umpPartName(part.type));
  }

  #processMediaHeader(header: MediaHeader): void {
    if (header.videoId && this.#video_id && header.videoId !== this.#video_id)
      throw new SabrError(`MediaHeader for the wrong video: got ${header.videoId}, expected ${this.#video_id}`);

    if (!header.formatId)
      throw new SabrError('MediaHeader without a format id');

    // Only ever observed as unset. Decompressing media would be silent
    // corruption if guessed wrong, so bail instead.
    if (header.compressionAlgorithm)
      throw new SabrError(`Compressed media is not supported (algorithm ${header.compressionAlgorithm})`);

    const key = formatKey(header.formatId);
    const format = this.#formats.get(key);

    if (!format)
      throw new SabrError(`MediaHeader for uninitialized format ${key}`);

    const is_init = !!header.isInitSeg;
    const sequence_number = header.sequenceNumber ?? -1;

    if (sequence_number === -1 && !is_init)
      throw new SabrError('MediaHeader without a sequence number for a media segment');

    const time_range = header.timeRange;
    const start_ms = header.startMs ?? (time_range ? ticksToMs(time_range.startTicks, time_range.timescale) : 0);

    const duration_from_range = time_range ? ticksToMs(time_range.durationTicks, time_range.timescale) : -1;
    const duration_ms = header.durationMs ?? (duration_from_range !== -1 ? duration_from_range : (is_init ? 0 : -1));

    if (duration_ms === -1)
      throw new SabrError(`Cannot determine the duration of segment ${sequence_number} of format ${key}`);

    const header_id = header.headerId ?? 0;

    this.#partials.set(header_id, {
      format_key: key,
      sequence_number,
      is_init,
      start_ms: Math.max(0, start_ms),
      duration_ms,
      content_length: header.contentLength ?? -1,
      chunks: [],
      received: 0
    });
  }

  /** `MEDIA` is a header-id VarInt followed by the segment bytes. */
  #processMedia(data: Uint8Array): void {
    const header_id = readUmpVarInt(data, 0);

    if (!header_id)
      throw new SabrError('MEDIA part without a header id');

    const segment = this.#partials.get(header_id.value);

    if (!segment)
      throw new SabrError(`MEDIA part for unknown header id ${header_id.value}`);

    const payload = data.subarray(header_id.next);

    // The decoder hands out views into its buffer, which the next chunk
    // invalidates — this has to own its bytes.
    segment.chunks.push(new Uint8Array(payload));
    segment.received += payload.length;
  }

  #processMediaEnd(data: Uint8Array): void {
    const header_id = readUmpVarInt(data, 0);

    if (!header_id)
      throw new SabrError('MEDIA_END part without a header id');

    const segment = this.#partials.get(header_id.value);

    if (!segment)
      throw new SabrError(`MEDIA_END part for unknown header id ${header_id.value}`);

    this.#partials.delete(header_id.value);

    if (segment.content_length !== -1 && segment.received !== segment.content_length) {
      throw new SabrError(
        `Truncated segment ${segment.sequence_number} of format ${segment.format_key}: ` +
        `got ${segment.received} of ${segment.content_length} bytes`
      );
    }

    this.#new_segments.push({
      format_key: segment.format_key,
      sequence_number: segment.sequence_number,
      is_init: segment.is_init,
      start_ms: segment.start_ms,
      duration_ms: segment.duration_ms,
      data: concat(segment.chunks, segment.received)
    });

    const format = this.#formats.get(segment.format_key);

    if (!format || segment.is_init)
      return;

    format.furthest_end_ms = Math.max(format.furthest_end_ms, segment.start_ms + segment.duration_ms);

    this.#recordConsumed(format, segment);
  }

  /**
   * Records the segment in the format's consumed ranges.
   *
   * These go back as `buffered_ranges`, which is how the server knows what not
   * to send again. Contiguous sequence numbers extend a range; a gap opens a new
   * one, so a seek does not make the client claim to hold everything in between.
   */
  #recordConsumed(format: TrackedFormat, segment: PartialSegment): void {
    const adjacent = format.consumed_ranges.find(
      (range) => range.end_sequence_number === segment.sequence_number - 1
    );

    if (!adjacent) {
      format.consumed_ranges.push({
        start_time_ms: segment.start_ms,
        duration_ms: segment.duration_ms,
        start_sequence_number: segment.sequence_number,
        end_sequence_number: segment.sequence_number
      });
      return;
    }

    adjacent.end_sequence_number = segment.sequence_number;
    adjacent.duration_ms = (segment.start_ms - adjacent.start_time_ms) + segment.duration_ms;
  }

  #processFormatInitializationMetadata(metadata: FormatInitializationMetadata): void {
    if (metadata.videoId && this.#video_id && metadata.videoId !== this.#video_id)
      throw new SabrError(`Format initialization for the wrong video: got ${metadata.videoId}, expected ${this.#video_id}`);

    if (!metadata.formatId)
      throw new SabrError('Format initialization without a format id');

    const key = formatKey(metadata.formatId);

    if (this.#formats.has(key))
      return;

    const duration_ms = ticksToMs(metadata.durationUnits, metadata.durationTimescale);
    const mime_type = metadata.mimeType;

    const format: TrackedFormat = {
      key,
      format_id: metadata.formatId,
      itag: metadata.formatId.itag ?? -1,
      mime_type,
      duration_ms: duration_ms !== -1 ? duration_ms : (metadata.endTimeMs ?? -1),
      total_segments: metadata.endSegmentNumber ?? -1,
      is_video: !!mime_type?.startsWith('video/'),
      consumed_ranges: [],
      furthest_end_ms: 0
    };

    this.#formats.set(key, format);
    this.#new_formats.push(format);

    Log.info(TAG_, `Format ${key} initialized: ${mime_type ?? '?'}, ${format.total_segments} segments, ${format.duration_ms} ms`);
  }

  #processNextRequestPolicy(policy: NextRequestPolicy): void {
    this.#next_request_policy = policy;

    // The cookie is the server's own continuation state. Once handed out it has
    // to ride along on every following request or the stream restarts.
    if (policy.playbackCookie)
      this.#playback_cookie = policy.playbackCookie;
  }

  #processSabrRedirect(redirect: SabrRedirect): void {
    if (!redirect.redirectUrl) {
      Log.warn(TAG_, 'SABR_REDIRECT without a URL, ignoring');
      return;
    }

    this.#redirect_url = redirect.redirectUrl;
  }

  #processStreamProtectionStatus(status: StreamProtectionStatus): void {
    switch (status.status) {
      case StreamProtectionStatus_Status.OK:
        this.#protection_status = 'ok';
        return;
      case StreamProtectionStatus_Status.ATTESTATION_PENDING:
        this.#protection_status = 'pending';
        return;
      case StreamProtectionStatus_Status.ATTESTATION_REQUIRED:
        this.#protection_status = 'required';
        Log.warn(TAG_, 'Server requires attestation — a PoToken is needed to keep this stream alive');
        return;
      default:
        this.#protection_status = 'unknown';
    }
  }

  #processSabrContextUpdate(update: SabrContextUpdate): void {
    if (update.type === undefined || update.value === undefined || update.writePolicy === undefined) {
      Log.warn(TAG_, 'Incomplete SABR_CONTEXT_UPDATE, ignoring');
      return;
    }

    if (
      update.writePolicy === SabrContextUpdate_SabrContextWritePolicy.SABR_CONTEXT_WRITE_POLICY_KEEP_EXISTING &&
      this.#sabr_context_updates.has(update.type)
    ) {
      return;
    }

    // Almost always an attempt to inject ads. Echoing it back is what keeps the
    // server sending media, so it is stored rather than dropped.
    Log.warn(TAG_, `Received a SABR context update (type ${update.type})`);

    this.#sabr_context_updates.set(update.type, update);

    if (update.sendByDefault)
      this.#sabr_contexts_to_send.add(update.type);
  }

  #processSabrContextSendingPolicy(policy: SabrContextSendingPolicy): void {
    for (const type of policy.startPolicy ?? [])
      this.#sabr_contexts_to_send.add(type);

    for (const type of policy.stopPolicy ?? [])
      this.#sabr_contexts_to_send.delete(type);

    for (const type of policy.discardPolicy ?? []) {
      this.#sabr_contexts_to_send.delete(type);
      this.#sabr_context_updates.delete(type);
    }
  }

  #processSabrError(error: SabrErrorMessage): void {
    throw new SabrError(
      `SABR protocol error: type=${error.type ?? '?'} action=${error.action ?? '?'} ` +
      `status=${error.error?.statusCode ?? '?'}`
    );
  }

  #processSabrSeek(seek: SabrSeek): void {
    const target = ticksToMs(seek.seekMediaTime, seek.seekMediaTimescale);

    if (target === -1)
      throw new SabrError('SABR_SEEK without usable seek data');

    Log.info(TAG_, `Server seeked to ${target} ms`);
    this.#player_time_ms = target;
  }

  /**
   * Moves the playhead to the first point not yet covered by **every** format.
   *
   * Call once per response: without it the next request asks for the same place
   * again and the server, seeing the range already buffered, answers with no
   * media at all.
   *
   * **The minimum, not the maximum.** One request carries both tracks, and their
   * segment boundaries do not line up — measured, a video segment runs 5.4 s and
   * an audio segment 9.9 s. Advancing to the furthest point means the audio track
   * drags the playhead past a video segment that never arrived, and the next
   * response starts beyond it: the track gets a hole the server will not fill,
   * and playback stalls on that segment forever. Seen on the device as
   * "did not deliver segment 46", reproduced with
   * `dev-scripts/phase65-stress.mjs`.
   */
  advance(): void {
    let next: number | undefined;

    for (const format of this.#formats.values()) {
      // A format that has delivered nothing yet says nothing about coverage.
      if (format.furthest_end_ms <= 0)
        continue;

      next = next === undefined ? format.furthest_end_ms : Math.min(next, format.furthest_end_ms);
    }

    if (next !== undefined && next > this.#player_time_ms)
      this.#player_time_ms = next;
  }

  /** Repositions the playhead and forgets what was buffered past it. */
  seek(time_ms: number): void {
    this.#player_time_ms = Math.max(0, time_ms);

    for (const format of this.#formats.values()) {
      format.consumed_ranges = format.consumed_ranges.filter(
        (range) => range.start_time_ms + range.duration_ms <= this.#player_time_ms
      );
      format.furthest_end_ms = 0;
    }
  }

  /** `true` once every initialized format has reported its last segment. */
  isComplete(): boolean {
    if (!this.#formats.size)
      return false;

    for (const format of this.#formats.values()) {
      if (format.total_segments === -1)
        return false;

      const received = format.consumed_ranges.reduce(
        (sum, range) => sum + (range.end_sequence_number - range.start_sequence_number + 1),
        0
      );

      if (received < format.total_segments)
        return false;
    }

    return true;
  }

  #buildStreamerContext(client_info: StreamerContext_ClientInfo): StreamerContext {
    const sabr_contexts = [ ...this.#sabr_context_updates.values() ]
      .filter((update) => this.#sabr_contexts_to_send.has(update.type!))
      .map((update) => ({ type: update.type, value: update.value }));

    // Types the server told us to send but whose payload we never received.
    const unsent = [ ...this.#sabr_contexts_to_send ]
      .filter((type) => !this.#sabr_context_updates.has(type));

    return {
      clientInfo: client_info,
      poToken: this.#po_token,
      playbackCookie: this.#playback_cookie
        ? PlaybackCookie.encode(this.#playback_cookie).finish()
        : undefined,
      sabrContexts: sabr_contexts,
      unsentSabrContexts: unsent
    };
  }

  #buildBufferedRanges(): BufferedRange[] {
    const ranges: BufferedRange[] = [];

    for (const format of this.#formats.values()) {
      for (const range of format.consumed_ranges) {
        ranges.push({
          formatId: format.format_id,
          startTimeMs: range.start_time_ms,
          durationMs: range.duration_ms,
          startSegmentIndex: range.start_sequence_number,
          endSegmentIndex: range.end_sequence_number
        });
      }
    }

    return ranges;
  }

  /**
   * Encodes the next `VideoPlaybackAbrRequest`.
   *
   * `selected_format_ids` are the formats we already hold metadata for;
   * `preferred_*` are what we are asking for. The first request has no selected
   * formats, which is what makes the server send initialization metadata.
   */
  buildRequest(options: {
    ustreamer_config: Uint8Array;
    client_info: StreamerContext_ClientInfo;
    video_format_id?: FormatId;
    audio_format_id?: FormatId;
    /** Defaults to both tracks; narrow it to fetch one track on its own. */
    enabled_track_types?: number;
    /** Bytes per second, passed through to the server's ABR decision. */
    bandwidth_estimate?: number;
  }): Uint8Array {
    const preferred_video = options.video_format_id ? [ options.video_format_id ] : [];
    const preferred_audio = options.audio_format_id ? [ options.audio_format_id ] : [];

    const client_abr_state: ClientAbrState = {
      playerTimeMs: this.#player_time_ms,
      playbackRate: 1,
      elapsedWallTimeMs: 0,
      enabledTrackTypesBitfield: options.enabled_track_types ?? EnabledTrackTypes.VIDEO_AND_AUDIO,
      clientViewportIsFlexible: false,
      drcEnabled: false,
      sabrForceMaxNetworkInterruptionDurationMs: 0,
      bandwidthEstimate: options.bandwidth_estimate
    };

    const request: VideoPlaybackAbrRequest = {
      clientAbrState: client_abr_state,
      selectedFormatIds: [ ...this.#formats.values() ].map((format) => format.format_id),
      bufferedRanges: this.#buildBufferedRanges(),
      playerTimeMs: this.#player_time_ms,
      videoPlaybackUstreamerConfig: options.ustreamer_config,
      preferredAudioFormatIds: preferred_audio,
      preferredVideoFormatIds: preferred_video,
      preferredSubtitleFormatIds: [],
      streamerContext: this.#buildStreamerContext(options.client_info),
      field1000: []
    };

    return VideoPlaybackAbrRequest.encode(request).finish();
  }
}
