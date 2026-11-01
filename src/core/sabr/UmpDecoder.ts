/**
 * Decoder for UMP (Universal Media Playback), the framing SABR responses use.
 *
 * A response is a flat sequence of parts, each one a `(type, size, payload)`
 * triple where type and size are UMP VarInts — a length-prefixed encoding
 * unrelated to protobuf's. The payload of most parts is a protobuf message; the
 * media parts carry a header id followed by raw bytes.
 *
 * Ported from SmartTube's `parser/ump/UMPDecoder.java` (Apache-2.0). The format
 * itself is documented at
 * https://github.com/gsuberland/UMP_Format/blob/main/UMP_Format.md
 *
 * The decoder is **incremental**: SABR responses arrive as a stream and a part
 * regularly straddles two chunks. Feed whatever arrives through `push()` and
 * drain what is complete with `parts()`; the remainder stays buffered.
 */
import { UmpPartId } from '../../../protos/generated/sabr/other/ump_part_id.js';

/** Part names for logs, derived from the generated enum so the two cannot drift. */
const PART_NAMES = new Map<number, string>(
  Object.entries(UmpPartId)
    .filter(([ , value ]) => typeof value === 'number')
    .map(([ name, value ]) => [ value as number, name ])
);

export function umpPartName(type: number): string {
  return PART_NAMES.get(type) ?? `UNKNOWN(${type})`;
}

export interface UmpPart {
  type: number;
  /** Name from `UmpPartId`, or `UNKNOWN(n)`. For logs and errors only. */
  name: string;
  /**
   * The part's payload. A view into the decoder's buffer — valid until the next
   * `push()`. Copy it if it has to outlive the current drain.
   */
  data: Uint8Array;
}

/**
 * Size of a UMP VarInt, encoded in the leading bits of its first byte.
 * Unlike protobuf there is no continuation bit: the first byte states the total.
 */
function varIntSize(first: number): number {
  if (first < 128) return 1;
  if (first < 192) return 2;
  if (first < 224) return 3;
  if (first < 240) return 4;
  return 5;
}

export interface UmpVarInt {
  value: number;
  /** Offset just past the VarInt. */
  next: number;
}

/**
 * Reads a UMP VarInt at `offset`, or `null` if the buffer ends inside it.
 *
 * The accumulation is done with multiplication rather than `<<`: a 5-byte VarInt
 * exceeds 32 bits, where shifting would silently wrap.
 */
export function readUmpVarInt(data: Uint8Array, offset: number): UmpVarInt | null {
  if (offset >= data.length)
    return null;

  const first = data[offset];
  const size = varIntSize(first);

  if (offset + size > data.length)
    return null;

  let value = 0;
  let shift = 0;

  // A 5-byte VarInt carries no payload bits in its first byte.
  if (size !== 5) {
    shift = 8 - size;
    value = first & ((1 << shift) - 1);
  }

  for (let i = 1; i < size; i++) {
    value += data[offset + i] * 2 ** shift;
    shift += 8;
  }

  return { value, next: offset + size };
}

export class UmpDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #offset = 0;

  /** Bytes buffered but not yet forming a complete part. */
  get pending(): number {
    return this.#buffer.length - this.#offset;
  }

  push(chunk: Uint8Array): void {
    if (!chunk.length)
      return;

    const remainder = this.#buffer.subarray(this.#offset);
    const merged = new Uint8Array(remainder.length + chunk.length);

    merged.set(remainder, 0);
    merged.set(chunk, remainder.length);

    this.#buffer = merged;
    this.#offset = 0;
  }

  /**
   * Yields every part the buffer holds in full, consuming as it goes.
   *
   * Stops as soon as a part is incomplete, leaving it buffered for the next
   * `push()`. Each yielded `data` is a view into the buffer, so consumers that
   * keep it beyond the current iteration have to copy.
   */
  * parts(): Generator<UmpPart> {
    while (this.#offset < this.#buffer.length) {
      const type = readUmpVarInt(this.#buffer, this.#offset);

      if (!type)
        return;

      const size = readUmpVarInt(this.#buffer, type.next);

      if (!size)
        return;

      const start = size.next;
      const end = start + size.value;

      if (end > this.#buffer.length)
        return;

      this.#offset = end;

      yield {
        type: type.value,
        name: umpPartName(type.value),
        data: this.#buffer.subarray(start, end)
      };
    }
  }

  reset(): void {
    this.#buffer = new Uint8Array(0);
    this.#offset = 0;
  }
}
