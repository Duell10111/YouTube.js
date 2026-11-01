/**
 * Turns a {@link SabrStream} into something addressable by segment number.
 *
 * SABR pushes: the server decides what to send and in which order, and a request
 * usually returns several segments of both tracks at once. A player asks the
 * opposite way round — "give me segment 42 of format 401" — so something has to
 * sit in between, pull the stream forward and hold what has arrived.
 *
 * This is the object the local segment server (plan phase 6.5) hands its
 * requests to: `#EXT-X-MAP` maps to {@link getInit}, each `#EXTINF` entry to
 * {@link getSegment}.
 *
 * **Random access.** The stream itself only moves forward, so a segment behind
 * the playhead would be unreachable. {@link getSegment} therefore re-seeks when
 * it notices the stream has already passed the wanted segment — which is what
 * makes it usable as a server handler, where the player decides the order.
 */
import * as Log from '../../utils/Log.js';
import { parseSidx } from '../../utils/Mp4SidxParser.js';
import { InnertubeError } from '../../utils/Utils.js';
import type { SabrStream } from './SabrStream.js';

import type { SabrFormat, SabrSegment } from './SabrProcessor.js';

const TAG_ = 'SabrSegmentSource';

export interface SabrSegmentSourceOptions {
  /**
   * How many segments per format to keep after they have been handed out.
   *
   * A player asks for segments roughly in order but re-reads the odd one, so a
   * small window absorbs that without holding the whole video in memory.
   * Defaults to `12`.
   */
  window?: number;
}

/** `sabr://video?key=401:` — the URL form `StreamingInfo` emits for SABR. */
export function parseSabrUrl(url: string): { kind: 'video' | 'audio'; key: string } | null {
  const match = (/^sabr:\/\/(video|audio)\?key=(.*)$/).exec(url);

  if (!match)
    return null;

  return { kind: match[1] as 'video' | 'audio', key: decodeURIComponent(match[2]) };
}

export class SabrSegmentSource {
  readonly #stream: SabrStream;
  readonly #window: number;

  /** format key -> sequence number -> segment. `-1` holds the init segment. */
  readonly #cache = new Map<string, Map<number, SabrSegment>>();
  /** Highest sequence number seen per format, cached or already evicted. */
  readonly #highest_seen = new Map<string, number>();
  /**
   * Sequence numbers a caller is currently waiting for, per format.
   *
   * These are exempt from eviction. Without that, a player reading far ahead
   * breaks itself: thirty concurrent requests drag the stream tens of segments
   * forward, the window drops a segment that is still being awaited, and the
   * waiter then sees "the stream has passed it" and re-seeks — which clears the
   * cache out from under every other waiter. Measured with
   * `dev-scripts/phase65-stress.mjs`.
   */
  readonly #waiting = new Map<string, Set<number>>();
  /**
   * Exact start time in ms of every segment, per format, from the `sidx` box in
   * the init segment. Index 0 is segment 1.
   *
   * Needed because a seek addresses a **time**, not a segment number, and
   * YouTube's segments are far from equal length — in one measured stream the
   * first was 3.92 s and the second 5.88 s. Estimating from the average lands in
   * the wrong segment, the server then starts past the one that was wanted, and
   * the lookup fails however often it is retried.
   */
  readonly #segment_starts = new Map<string, number[]>();

  #iterator?: AsyncGenerator<SabrSegment>;
  #exhausted = false;
  /** Serializes pulls: the underlying stream has one position, not many. */
  #pump?: Promise<void>;

  constructor(stream: SabrStream, options: SabrSegmentSourceOptions = {}) {
    this.#stream = stream;
    this.#window = options.window ?? 12;
  }

  get formats(): SabrFormat[] {
    return this.#stream.formats;
  }

  /**
   * Pulls until every format is initialized and has delivered its init segment.
   *
   * The first response carries the format metadata, so this is also what makes
   * `total_segments` and `duration_ms` available — which `toHLS` needs before it
   * can write a playlist.
   */
  async open(): Promise<SabrFormat[]> {
    while (!this.#exhausted) {
      const formats = this.#stream.formats;

      if (formats.length && formats.every((format) => this.#cache.get(format.key)?.has(-1)))
        return formats;

      if (!await this.#pullOnce())
        break;
    }

    const formats = this.#stream.formats;

    if (!formats.length)
      throw new InnertubeError('The SABR stream initialized no formats');

    const missing = formats.filter((format) => !this.#cache.get(format.key)?.has(-1));

    if (missing.length)
      throw new InnertubeError(`The SABR stream sent no initialization segment for ${missing.map((f) => f.key).join(', ')}`);

    return formats;
  }

  /** The `#EXT-X-MAP` payload: the format's initialization segment. */
  async getInit(format_key: string): Promise<Uint8Array> {
    return (await this.#await(format_key, -1)).data;
  }

  async getSegment(format_key: string, sequence_number: number): Promise<Uint8Array> {
    return (await this.#await(format_key, sequence_number)).data;
  }

  /**
   * Repositions the stream. Everything cached past the target is dropped: after
   * a seek the server renumbers nothing, but holding segments the player will
   * not ask for again only costs memory.
   */
  seek(time_ms: number): void {
    this.#stream.seek(time_ms);
    this.#exhausted = false;
    this.#iterator = undefined;

    // Must be cleared with the position, or `#hasPassed` would keep reporting
    // the pre-seek high-water mark and every lookup would fail immediately.
    this.#highest_seen.clear();

    for (const [ key, segments ] of this.#cache) {
      const waiting = this.#waiting.get(key);

      for (const sequence of [ ...segments.keys() ]) {
        // The init segment stays valid across a seek and is expensive to refetch.
        // Anything still awaited is kept too: a seek driven by one waiter must
        // not throw away what another one has already been handed.
        if (sequence === -1 || waiting?.has(sequence))
          continue;

        segments.delete(sequence);
      }
    }
  }

  /**
   * How often a lookup may reposition the stream before giving up.
   *
   * The server picks the segment covering the requested time, and its idea of
   * that boundary can be one off ours — so one corrective seek is expected and a
   * second is the margin. More than that is a disagreement no retry will fix.
   */
  static readonly #MAX_SEEK_ATTEMPTS = 3;

  async #await(format_key: string, sequence_number: number): Promise<SabrSegment> {
    this.#beginWaiting(format_key, sequence_number);

    try {
      return await this.#awaitInner(format_key, sequence_number);
    } finally {
      this.#endWaiting(format_key, sequence_number);
    }
  }

  #beginWaiting(format_key: string, sequence_number: number): void {
    const waiting = this.#waiting.get(format_key) ?? new Set<number>();
    waiting.add(sequence_number);
    this.#waiting.set(format_key, waiting);
  }

  #endWaiting(format_key: string, sequence_number: number): void {
    const waiting = this.#waiting.get(format_key);

    if (!waiting)
      return;

    waiting.delete(sequence_number);

    // The segment stays cached; it only becomes evictable again. Dropping it
    // here would defeat the point of the window for a player that re-reads.
    if (!waiting.size)
      this.#waiting.delete(format_key);
  }

  async #awaitInner(format_key: string, sequence_number: number): Promise<SabrSegment> {
    for (let attempt = 0; attempt < SabrSegmentSource.#MAX_SEEK_ATTEMPTS; attempt++) {
      // Pull forward until the segment shows up, the stream ends, or it turns
      // out the stream is already past it.
      for (;;) {
        const cached = this.#cache.get(format_key)?.get(sequence_number);

        if (cached)
          return cached;

        if (this.#exhausted || this.#hasPassed(format_key, sequence_number))
          break;

        await this.#pullOnce();
      }

      // An init segment has no position to seek to, and `open()` guarantees it.
      if (sequence_number === -1)
        break;

      const target_ms = this.#estimateStartMs(format_key, sequence_number);

      if (target_ms === null)
        break;

      Log.debug(TAG_, `Segment ${sequence_number} of ${format_key} is behind the stream, re-seeking to ${target_ms} ms`);
      this.seek(target_ms);
    }

    throw new InnertubeError(
      `The SABR stream did not deliver segment ${sequence_number === -1 ? 'init' : sequence_number} of format ${format_key}`
    );
  }

  /** `true` when the stream has moved beyond `sequence_number` for this format. */
  #hasPassed(format_key: string, sequence_number: number): boolean {
    if (sequence_number === -1)
      return false;

    return (this.#highest_seen.get(format_key) ?? -1) > sequence_number;
  }

  /**
   * Start time of a segment, estimated from the format's own metadata.
   *
   * There is no way to ask for a segment by number — the request carries a time —
   * so the number has to be turned back into one. Segments are of even length in
   * practice, and landing slightly early is harmless: the source then pulls
   * forward to the wanted one. Landing late is not, hence the half-segment bias.
   */
  #estimateStartMs(format_key: string, sequence_number: number): number | null {
    // Aim at the **previous** segment's start, not the wanted one's: the server
    // sends the segment covering the requested time, and landing exactly on a
    // boundary is a coin flip. One segment of overshoot costs a single extra
    // segment; undershooting costs the request.
    const target_sequence = Math.max(1, sequence_number - 1);
    const exact = this.#segmentStarts(format_key)?.[target_sequence - 1];

    if (exact !== undefined)
      return Math.max(0, Math.floor(exact));

    const format = this.#stream.formats.find((candidate) => candidate.key === format_key);

    if (!format || format.total_segments <= 0 || format.duration_ms <= 0)
      return null;

    // Fallback without a `sidx`: even division. Inexact by nature, which is why
    // it stays the fallback.
    const segment_ms = format.duration_ms / format.total_segments;

    return Math.max(0, Math.floor((target_sequence - 1) * segment_ms));
  }

  /**
   * Cumulative segment start times of a format, read once from its init segment.
   *
   * `undefined` when the init segment is not cached yet or carries no `sidx` —
   * both leave the caller on the even-division fallback.
   */
  #segmentStarts(format_key: string): number[] | undefined {
    const known = this.#segment_starts.get(format_key);

    if (known)
      return known;

    const init = this.#cache.get(format_key)?.get(-1);

    if (!init)
      return undefined;

    try {
      const sidx = parseSidx(init.data);

      if (!sidx.segments.length)
        return undefined;

      const starts: number[] = [];
      let elapsed = 0;

      for (const segment of sidx.segments) {
        starts.push(elapsed * 1000);
        elapsed += segment.duration;
      }

      this.#segment_starts.set(format_key, starts);
      return starts;
    } catch (error) {
      Log.debug(TAG_, `No usable sidx in the init segment of ${format_key}`, error);
      return undefined;
    }
  }

  /**
   * Advances the stream by one segment.
   *
   * Concurrent callers share the same pull: the stream has a single position, so
   * two parallel `getSegment` calls must not both drive it.
   */
  async #pullOnce(): Promise<boolean> {
    if (this.#pump) {
      await this.#pump;
      return !this.#exhausted;
    }

    this.#pump = (async () => {
      this.#iterator ??= this.#stream.segments();

      const next = await this.#iterator.next();

      if (next.done) {
        this.#exhausted = true;
        return;
      }

      this.#store(next.value);
    })();

    try {
      await this.#pump;
    } finally {
      this.#pump = undefined;
    }

    return !this.#exhausted;
  }

  #store(segment: SabrSegment): void {
    const key = segment.is_init ? -1 : segment.sequence_number;
    const segments = this.#cache.get(segment.format_key) ?? new Map<number, SabrSegment>();

    segments.set(key, segment);
    this.#cache.set(segment.format_key, segments);

    if (!segment.is_init) {
      const highest = this.#highest_seen.get(segment.format_key) ?? -1;

      if (segment.sequence_number > highest)
        this.#highest_seen.set(segment.format_key, segment.sequence_number);
    }

    this.#evict(segment.format_key, segments);
  }

  /**
   * Drops the oldest media segments beyond the window.
   *
   * Never the init segment, and never one a caller is waiting for — see
   * {@link SabrSegmentSource.#waiting}. A window that cannot be honoured because
   * everything in it is awaited is allowed to overflow: the alternative is
   * failing a request the player is holding open.
   */
  #evict(format_key: string, segments: Map<number, SabrSegment>): void {
    const waiting = this.#waiting.get(format_key);

    const evictable = [ ...segments.keys() ]
      .filter((key) => key !== -1 && !waiting?.has(key))
      .sort((a, b) => a - b);

    const surplus = segments.size - 1 - this.#window;

    for (const key of evictable.slice(0, Math.max(0, surplus)))
      segments.delete(key);
  }

  async close(): Promise<void> {
    this.#exhausted = true;

    try {
      await this.#iterator?.return(undefined as never);
    } catch (error) {
      Log.warn(TAG_, 'Error while closing the SABR stream', error);
    }

    this.#iterator = undefined;
    this.#cache.clear();
  }
}
