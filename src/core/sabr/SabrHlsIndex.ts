/**
 * Builds the segment schedule a `segments`-mode HLS playlist needs.
 *
 * An HLS playlist for on-demand content has to list every segment with its
 * duration before playback starts, but SABR only reveals a segment's real
 * duration when it arrives. The way out is that YouTube puts a `sidx` box into
 * the **initialization segment** of a SABR format — the same index the byte-range
 * path fetches separately — so the exact schedule is already in hand once
 * `SabrSegmentSource.open()` has run. No extra request, and the durations are
 * the real ones rather than an average.
 *
 * Where a format carries no `sidx`, the schedule is divided evenly from the
 * format's total duration and segment count. That is a fallback, not the plan:
 * uneven segments then make the playlist drift against the media, which shows up
 * as inaccurate seeking.
 */
import * as Log from '../../utils/Log.js';
import { parseSidx } from '../../utils/Mp4SidxParser.js';

import type { SabrPlaylistIndex } from '../../types/HlsOptions.js';
import type { SabrFormat } from './SabrProcessor.js';
import type { SabrSegmentSource } from './SabrSegmentSource.js';

const TAG_ = 'SabrHlsIndex';

function evenlyDivided(format: SabrFormat): SabrPlaylistIndex | null {
  if (format.total_segments <= 0 || format.duration_ms <= 0)
    return null;

  const segment_sec = format.duration_ms / format.total_segments / 1000;

  return { durations: new Array<number>(format.total_segments).fill(segment_sec) };
}

/**
 * Reads the schedule of every initialized format out of its init segment.
 *
 * Call after {@link SabrSegmentSource.open}; the result goes straight into
 * `toHLS`'s `sabr.index`.
 */
export async function buildSabrHlsIndex(source: SabrSegmentSource): Promise<Record<string, SabrPlaylistIndex>> {
  const index: Record<string, SabrPlaylistIndex> = {};

  for (const format of source.formats) {
    const init = await source.getInit(format.key);

    let from_sidx: SabrPlaylistIndex | null = null;

    try {
      const sidx = parseSidx(init);

      if (sidx.segments.length)
        from_sidx = { durations: sidx.segments.map((segment) => segment.duration) };
    } catch (error) {
      Log.debug(TAG_, `No usable sidx in the init segment of ${format.key}`, error);
    }

    // The server's own segment count wins where the two disagree: it is what the
    // sequence numbers in the requests are counted against.
    if (from_sidx && format.total_segments > 0 && from_sidx.durations.length !== format.total_segments) {
      Log.warn(
        TAG_,
        `sidx of ${format.key} describes ${from_sidx.durations.length} segments but the server announced ` +
        `${format.total_segments}; falling back to even division`
      );
      from_sidx = null;
    }

    const schedule = from_sidx ?? evenlyDivided(format);

    if (!schedule) {
      Log.warn(TAG_, `Cannot build a segment schedule for ${format.key}, leaving it out`);
      continue;
    }

    index[format.key] = schedule;
  }

  return index;
}
