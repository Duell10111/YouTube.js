import type { IPlayabilityStatus, IStreamingData } from '../../parser/types/index.js';
import type { InnerTubeClient } from '../../types/index.js';
import { Log } from '../../utils/index.js';

const TAG = 'PlaybackResolver';

/**
 * Minimal shape the resolver needs. Both `YT.VideoInfo` and `YTTV.VideoInfo`
 * satisfy it, so the resolver works for either.
 */
export interface PlayableInfoLike {
  playability_status?: IPlayabilityStatus;
  streaming_data?: IStreamingData;
}

export interface PlaybackAttempt {
  client: InnerTubeClient;
  ok: boolean;
  status?: string;
  reason?: string;
  /** Number of video formats that carry a URL or a cipher, i.e. are usable without SABR. */
  usable_video_formats?: number;
  /** Set when the request itself failed. */
  error?: string;
  duration_ms: number;
}

export interface ResolvePlayableInfoOptions<T> {
  /** Clients to try, in order. Defaults to {@linkcode DEFAULT_PLAYBACK_CLIENTS}. */
  clients?: InnerTubeClient[];
  /**
   * Decides whether a response is good enough to stop at.
   * Defaults to {@linkcode isPlayableWithFormats}.
   */
  accept?: (info: T) => boolean;
  /**
   * Second, looser predicate. After no client satisfied `accept`, the clients are
   * tried once more with this one. Defaults to {@linkcode hasAnyFormats}.
   * Pass `null` to skip the second pass.
   */
  accept_fallback?: ((info: T) => boolean) | null;
  /**
   * Clients for the fallback pass, appended to `clients`.
   *
   * Needed when `accept` is narrow enough that only a couple of clients can ever
   * satisfy it — asking a wider set right away would waste requests, but once the
   * narrow set has failed the wider one is what keeps playback working. Responses
   * already fetched in the first pass are reused.
   */
  clients_fallback?: InnerTubeClient[];
  /** Called after every attempt — useful for logging and diagnostics. */
  on_attempt?: (attempt: PlaybackAttempt) => void;
  /**
   * Supplies a PoToken per client for the `/player` request, taking precedence
   * over a fixed `po_token`. Return `undefined` for clients that need none.
   *
   * Web clients (`WEB`, `MWEB`, …) want a content-bound token (minted for the
   * video id); app clients such as `IOS` attest differently and ignore it.
   * Only `getPlayableInfo` uses this — `resolvePlayableInfo` itself does not.
   */
  po_token_for?: (client: InnerTubeClient) => Promise<string | undefined> | string | undefined;
  /**
   * Requests only `/player`, not `/next`. Needed for `TV_DOWNGRADED` with
   * credentials: it returns a signed-in user's private videos from `/player`,
   * but answers `/next` with HTTP 400 (measured 2026-10-04). Only
   * `Innertube#getPlayableInfo` uses this.
   */
  player_only?: boolean;
}

export interface ResolvedPlayableInfo<T> {
  info: T;
  /** The client the returned info came from. */
  client: InnerTubeClient;
  /** Whether it satisfied the primary predicate or only the fallback one. */
  satisfied: 'primary' | 'fallback';
  attempts: PlaybackAttempt[];
}

/**
 * Default order, derived from measurements (see `docs/playback-matrix.md`).
 *
 * Deliberately absent: `TV` and `TV_EMBEDDED` (always UNPLAYABLE, with or
 * without authentication), and `WEB`/`ANDROID` (their formats carry neither URL
 * nor cipher — they are SABR-only and need a SABR client instead).
 */
export const DEFAULT_PLAYBACK_CLIENTS: InnerTubeClient[] = [
  'TV_SIMPLY',
  'IOS',
  'VISIONOS',
  'ANDROID_VR',
  'TV_DOWNGRADED',
  'MWEB'
] as InnerTubeClient[];

/** Video formats that can be fetched over plain HTTP, i.e. not SABR-only. */
export function countUsableVideoFormats(info: PlayableInfoLike): number {
  const streaming_data = info.streaming_data;

  if (!streaming_data)
    return 0;

  return [ ...(streaming_data.formats || []), ...(streaming_data.adaptive_formats || []) ]
    .filter((format) => format.has_video && (format.url || format.signature_cipher || format.cipher))
    .length;
}

/** Primary predicate: playable *and* something we can actually fetch. */
export function isPlayableWithFormats(info: PlayableInfoLike): boolean {
  return info.playability_status?.status === 'OK' && countUsableVideoFormats(info) > 0;
}

/** Fallback predicate: any streaming data at all, however unattractive. */
export function hasAnyFormats(info: PlayableInfoLike): boolean {
  const streaming_data = info.streaming_data;
  return !!streaming_data && (
    !!streaming_data.formats?.length ||
    !!streaming_data.adaptive_formats?.length ||
    !!streaming_data.hls_manifest_url ||
    !!streaming_data.dash_manifest_url
  );
}

/**
 * Tries a list of clients until one returns a usable player response.
 *
 * YouTube breaks individual clients regularly and without warning, so a single
 * client is never enough — this walks a prioritised list instead, the same way
 * SmartTube's `VideoInfoService#firstPlayable` does.
 *
 * @param fetchInfo - Fetches the player response for one client.
 * @param options - See {@linkcode ResolvePlayableInfoOptions}.
 */
export async function resolvePlayableInfo<T extends PlayableInfoLike>(
  fetchInfo: (client: InnerTubeClient) => Promise<T>,
  options: ResolvePlayableInfoOptions<T> = {}
): Promise<ResolvedPlayableInfo<T>> {
  const clients = options.clients?.length ? options.clients : DEFAULT_PLAYBACK_CLIENTS;
  const accept = options.accept ?? isPlayableWithFormats as (info: T) => boolean;
  const accept_fallback = options.accept_fallback === null
    ? null
    : options.accept_fallback ?? hasAnyFormats as (info: T) => boolean;

  const attempts: PlaybackAttempt[] = [];
  // Responses are kept so the fallback pass does not have to fetch them again.
  const responses = new Map<InnerTubeClient, T>();

  for (const client of clients) {
    const started = Date.now();

    try {
      const info = await fetchInfo(client);
      responses.set(client, info);

      const attempt: PlaybackAttempt = {
        client,
        ok: accept(info),
        status: info.playability_status?.status,
        reason: info.playability_status?.reason || undefined,
        usable_video_formats: countUsableVideoFormats(info),
        duration_ms: Date.now() - started
      };

      attempts.push(attempt);
      options.on_attempt?.(attempt);

      if (attempt.ok) {
        Log.info(TAG, `Using client ${client} (${attempt.usable_video_formats} usable video formats).`);
        return { info, client, satisfied: 'primary', attempts };
      }
    } catch (error: any) {
      const attempt: PlaybackAttempt = {
        client,
        ok: false,
        error: error?.message ? String(error.message) : String(error),
        duration_ms: Date.now() - started
      };

      attempts.push(attempt);
      options.on_attempt?.(attempt);
      Log.warn(TAG, `Client ${client} failed: ${attempt.error}`);
    }
  }

  if (accept_fallback) {
    const fallback_clients = [ ...clients, ...(options.clients_fallback ?? []).filter((client) => !clients.includes(client)) ];

    for (const client of fallback_clients) {
      let info = responses.get(client);

      if (!info) {
        const started = Date.now();

        try {
          info = await fetchInfo(client);
          responses.set(client, info);

          const attempt: PlaybackAttempt = {
            client,
            ok: false,
            status: info.playability_status?.status,
            reason: info.playability_status?.reason || undefined,
            usable_video_formats: countUsableVideoFormats(info),
            duration_ms: Date.now() - started
          };

          attempts.push(attempt);
          options.on_attempt?.(attempt);
        } catch (error: any) {
          const attempt: PlaybackAttempt = {
            client,
            ok: false,
            error: error?.message ? String(error.message) : String(error),
            duration_ms: Date.now() - started
          };

          attempts.push(attempt);
          options.on_attempt?.(attempt);
          Log.warn(TAG, `Client ${client} failed: ${attempt.error}`);
          continue;
        }
      }

      if (info && accept_fallback(info)) {
        Log.warn(TAG, `No client fully satisfied playback, falling back to ${client}.`);
        return { info, client, satisfied: 'fallback', attempts };
      }
    }
  }

  throw new PlaybackResolutionError(
    `None of the clients returned usable streaming data: ${attempts.map((a) => `${a.client}=${a.error ?? a.status ?? '?'}`).join(', ')}`,
    attempts
  );
}

export class PlaybackResolutionError extends Error {
  public attempts: PlaybackAttempt[];

  constructor(message: string, attempts: PlaybackAttempt[]) {
    super(message);
    this.name = 'PlaybackResolutionError';
    this.attempts = attempts;
  }
}
