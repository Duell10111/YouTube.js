import type { StreamingInfoOptions } from './StreamingInfoOptions.js';

export interface HlsOptions extends StreamingInfoOptions {
  /**
   * How the segments are addressed.
   *
   * * `byterange` (default): `EXT-X-BYTERANGE` straight onto the googlevideo
   *   URL — the player loads from YouTube, no server of our own involved.
   * * `segments`: path-based segment URLs for a local server, needed once
   *   playback moves to SABR. Not implemented yet.
   */
  mode?: 'byterange' | 'segments';
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
