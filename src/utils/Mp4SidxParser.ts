import { InnertubeError } from './Utils.js';

/**
 * Parser for the ISO BMFF Segment Index Box (`sidx`, ISO/IEC 14496-12).
 *
 * YouTube describes the segments of an adaptive format through a `sidx` box that
 * lives in the byte range given as `index_range`. DASH players resolve that
 * themselves, which is why `toDash()` only has to point at the range — but HLS
 * playlists have to list every segment explicitly, so the box has to be parsed
 * here.
 *
 * Only flat, media-referencing indexes are supported; YouTube does not use
 * hierarchical ones.
 */

export interface SidxSegment {
  /** Size of the segment in bytes. */
  size: number;
  /** Duration in `timescale` units. */
  duration_ticks: number;
  /** Duration in seconds. */
  duration: number;
}

export interface SidxInfo {
  timescale: number;
  earliest_presentation_time: number;
  /**
   * Distance between the end of the `sidx` box and the first segment.
   * Usually `0` for YouTube.
   */
  first_offset: number;
  segments: SidxSegment[];
  /** Sum of all segment durations, in seconds. */
  duration: number;
  /** Sum of all segment sizes, in bytes. */
  size: number;
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32(data: Uint8Array, offset: number): number {
  // Avoid bit shifts for the top byte — they would overflow into a negative number.
  return (data[offset] * 2 ** 24) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3];
}

function readU64(data: Uint8Array, offset: number): number {
  return readU32(data, offset) * 2 ** 32 + readU32(data, offset + 4);
}

function readBoxType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/**
 * Locates the `sidx` box in a buffer, skipping any boxes in front of it.
 *
 * @returns Offset of the box payload (after size and type), or `null` if absent.
 */
export function findSidxOffset(data: Uint8Array): number | null {
  let offset = 0;

  while (offset + 8 <= data.length) {
    let size = readU32(data, offset);
    const type = readBoxType(data, offset + 4);
    let header_size = 8;

    if (size === 1) {
      if (offset + 16 > data.length)
        return null;
      size = readU64(data, offset + 8);
      header_size = 16;
    } else if (size === 0) {
      // Box extends to the end of the buffer.
      size = data.length - offset;
    }

    if (type === 'sidx')
      return offset + header_size;

    if (size <= 0)
      return null;

    offset += size;
  }

  return null;
}

/**
 * Parses the segment index of an adaptive format.
 *
 * @param data - Bytes of the format's `index_range`.
 * @throws {InnertubeError} If no flat `sidx` box is found.
 */
export function parseSidx(data: Uint8Array): SidxInfo {
  const box_offset = findSidxOffset(data);

  if (box_offset === null) {
    throw new InnertubeError(
      'No sidx box found. WebM formats carry a Cues element instead and are not supported here.'
    );
  }

  let offset = box_offset;

  const version = data[offset];
  offset += 4; // version (1) + flags (3)
  offset += 4; // reference_ID

  const timescale = readU32(data, offset);
  offset += 4;

  let earliest_presentation_time: number;
  let first_offset: number;

  if (version === 0) {
    earliest_presentation_time = readU32(data, offset);
    offset += 4;
    first_offset = readU32(data, offset);
    offset += 4;
  } else {
    earliest_presentation_time = readU64(data, offset);
    offset += 8;
    first_offset = readU64(data, offset);
    offset += 8;
  }

  offset += 2; // reserved

  const reference_count = readU16(data, offset);
  offset += 2;

  if (!timescale)
    throw new InnertubeError('Invalid sidx box: timescale is zero');

  const segments: SidxSegment[] = [];

  for (let i = 0; i < reference_count; i++) {
    if (offset + 12 > data.length)
      throw new InnertubeError(`Truncated sidx box: expected ${reference_count} references, got ${segments.length}`);

    const first_word = readU32(data, offset);
    const is_hierarchical = (first_word & 0x80000000) !== 0;

    if (is_hierarchical)
      throw new InnertubeError('Hierarchical sidx boxes are not supported');

    const duration_ticks = readU32(data, offset + 4);

    segments.push({
      size: first_word & 0x7fffffff,
      duration_ticks,
      duration: duration_ticks / timescale
    });

    offset += 12;
  }

  return {
    timescale,
    earliest_presentation_time,
    first_offset,
    segments,
    duration: segments.reduce((total, segment) => total + segment.duration, 0),
    size: segments.reduce((total, segment) => total + segment.size, 0)
  };
}

export interface ByteRange {
  /** Absolute offset of the segment within the file. */
  offset: number;
  length: number;
  duration: number;
}

/**
 * Turns a parsed index into absolute byte ranges.
 *
 * Segment data starts right behind the `sidx` box, shifted by the box's
 * `first_offset`.
 *
 * @param index_range_end - Last byte of the format's `index_range` (inclusive).
 */
export function toByteRanges(sidx: SidxInfo, index_range_end: number): ByteRange[] {
  let offset = index_range_end + 1 + sidx.first_offset;

  return sidx.segments.map((segment) => {
    const range = { offset, length: segment.size, duration: segment.duration };
    offset += segment.size;
    return range;
  });
}
