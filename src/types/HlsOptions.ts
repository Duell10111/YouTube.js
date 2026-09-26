import type { StreamingInfoOptions } from './StreamingInfoOptions.js';

export interface SabrHlsOptions {
  /**
   * Prefix every segment URL is built on, without a trailing slash — the address
   * of the local SABR server, e.g. `http://127.0.0.1:51234/sabr/<token>`.
   *
   * The resulting paths are `<base_url>/<format key>/init.mp4` and
   * `<base_url>/<format key>/<sequence number>.m4s`, with the format key
   * percent-encoded.
   */
  base_url: string;
  /** Segment schedule per format key (`itag:xtags`). */
  index: Record<string, SabrPlaylistIndex>;
}

export interface SabrPlaylistIndex {
  /**
   * Duration of every segment in seconds, in sequence order.
   *
   * Sequence numbers are 1-based, so `durations[0]` describes segment `1` — the
   * same numbering the URLs use, which keeps the server from having to translate.
   */
  durations: number[];
}

export interface HlsOptions extends StreamingInfoOptions {
  /**
   * How the segments are addressed.
   *
   * * `byterange` (default): `EXT-X-BYTERANGE` straight onto the googlevideo
   *   URL — the player loads from YouTube, no server of our own involved.
   * * `segments`: path-based segment URLs, for playback over SABR. SABR has no
   *   byte ranges to point at, so the segments have to be served locally and the
   *   playlist addresses them by number. Requires {@link HlsOptions.sabr}.
   */
  mode?: 'byterange' | 'segments';
  /**
   * Where the segments of a `segments`-mode playlist are served from, and how
   * many there are per format.
   *
   * Build the index with `buildSabrHlsIndex()` from an opened
   * `SabrSegmentSource`; it reads the schedule out of each format's
   * initialization segment.
   */
  sabr?: SabrHlsOptions;
  /**
   * Video codecs to offer, best first. Matched against the codec family
   * (`av01`, `avc1`, …).
   *
   * Defaults to `['avc1', 'av01']`. The **first** family with renditions becomes
   * the base ladder; the others only add heights it cannot reach. avc1 leads
   * because every Apple device decodes it, while AV1 needs Apple TV 4K (3rd gen)
   * — a manifest made up purely of av01 leaves such a player with nothing to
   * select, which shows up as a stalled player rather than an error.
   *
   * Pass `['avc1']` to leave AV1 out entirely.
   */
  codec_preference?: string[];
  /** Tallest video rendition to offer, in pixels. */
  max_height?: number;
  /**
   * How many video renditions the master playlist offers. Defaults to `6`.
   *
   * Each one costs an index request before playback can start, so this is a
   * start-up latency knob, not a quality one.
   */
  max_video_renditions?: number;
}
