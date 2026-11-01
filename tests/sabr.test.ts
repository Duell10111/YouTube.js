import { describe, expect, test } from 'vitest';

import { FormatInitializationMetadata } from '../protos/generated/sabr/videostreaming/format_initialization_metadata.js';
import { MediaHeader } from '../protos/generated/sabr/videostreaming/media_header.js';
import { NextRequestPolicy } from '../protos/generated/sabr/videostreaming/next_request_policy.js';
import { SabrError as SabrErrorMessage } from '../protos/generated/sabr/videostreaming/sabr_error.js';
import { SabrRedirect } from '../protos/generated/sabr/videostreaming/sabr_redirect.js';
import { StreamProtectionStatus, StreamProtectionStatus_Status } from '../protos/generated/sabr/videostreaming/stream_protection_status.js';
import { VideoPlaybackAbrRequest } from '../protos/generated/sabr/videostreaming/video_playback_abr_request.js';
import { UmpPartId } from '../protos/generated/sabr/other/ump_part_id.js';

import { SabrError, SabrProcessor, formatKey } from '../dist/src/core/sabr/SabrProcessor.js';
import { UmpDecoder, readUmpVarInt } from '../dist/src/core/sabr/UmpDecoder.js';
import { parseSabrUrl } from '../dist/src/core/sabr/SabrSegmentSource.js';
import { buildSabrHlsIndex } from '../dist/src/core/sabr/SabrHlsIndex.js';

/* ------------------------------- UMP-Hilfsmittel ------------------------------ */

/**
 * Encodes a UMP VarInt — the inverse of `readUmpVarInt`.
 *
 * The first byte's leading bits state the total length, and whatever payload bits
 * are left in it hold the lowest bits of the value; the rest follow
 * little-endian. A 5-byte VarInt carries no payload in its first byte.
 */
function writeUmpVarInt(value: number): Uint8Array {
  if (value < 1 << 7)
    return Uint8Array.from([ value ]);

  if (value < 1 << 14)
    return Uint8Array.from([ 0x80 | (value & 0x3f), (value >>> 6) & 0xff ]);

  if (value < 1 << 21)
    return Uint8Array.from([ 0xc0 | (value & 0x1f), (value >>> 5) & 0xff, (value >>> 13) & 0xff ]);

  if (value < 1 << 28) {
    return Uint8Array.from([
      0xe0 | (value & 0x0f), (value >>> 4) & 0xff, (value >>> 12) & 0xff, (value >>> 20) & 0xff
    ]);
  }

  return Uint8Array.from([
    0xf0, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff
  ]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function umpPart(type: number, payload: Uint8Array): Uint8Array {
  return concat([ writeUmpVarInt(type), writeUmpVarInt(payload.length), payload ]);
}

/** A `MEDIA` part: header id VarInt followed by the segment bytes. */
function mediaPart(header_id: number, data: Uint8Array): Uint8Array {
  return umpPart(UmpPartId.MEDIA, concat([ writeUmpVarInt(header_id), data ]));
}

/** Feeds `count` consecutive 5-second segments through the processor. */
function bufferSegments(processor: SabrProcessor, count: number): void {
  for (let sequence = 1; sequence <= count; sequence++) {
    drain(processor, segment({
      header_id: sequence,
      sequence_number: sequence,
      start_ms: (sequence - 1) * 5000,
      duration_ms: 5000,
      data: new Uint8Array(4)
    }));
  }
}

function drain(processor: SabrProcessor, buffer: Uint8Array): void {
  const decoder = new UmpDecoder();
  decoder.push(buffer);

  for (const part of decoder.parts())
    processor.process(part);
}

const VIDEO_FORMAT = { itag: 401, lastModified: 1700000000000, xtags: undefined };
const VIDEO_KEY = '401:';

/** Eine zweite Spur mit **anderer** Segmentlänge — darauf beruht der Fehler in `advance()`. */
const AUDIO_FORMAT = { itag: 140, lastModified: 1700000000000, xtags: undefined };
const AUDIO_KEY = '140:';

function audioInit(): Uint8Array {
  return umpPart(UmpPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
    videoId: 'bUHZ2k9DYHY',
    formatId: AUDIO_FORMAT,
    endSegmentNumber: 106,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    durationUnits: 1051492,
    durationTimescale: 1000
  } as FormatInitializationMetadata).finish());
}

/** Ein Segment einer beliebigen Spur. */
function segmentOf(format: typeof VIDEO_FORMAT, options: {
  header_id: number;
  sequence_number: number;
  start_ms: number;
  duration_ms: number;
}): Uint8Array {
  const header = MediaHeader.encode({
    headerId: options.header_id,
    videoId: 'bUHZ2k9DYHY',
    formatId: format,
    itag: format.itag,
    sequenceNumber: options.sequence_number,
    startMs: options.start_ms,
    durationMs: options.duration_ms,
    contentLength: 4
  } as MediaHeader).finish();

  return concat([
    umpPart(UmpPartId.MEDIA_HEADER, header),
    mediaPart(options.header_id, new Uint8Array(4)),
    umpPart(UmpPartId.MEDIA_END, writeUmpVarInt(options.header_id))
  ]);
}

function formatInit(overrides: Partial<FormatInitializationMetadata> = {}): Uint8Array {
  return umpPart(UmpPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
    videoId: 'bUHZ2k9DYHY',
    formatId: VIDEO_FORMAT,
    endSegmentNumber: 195,
    mimeType: 'video/mp4; codecs="av01.0.12M.08"',
    durationUnits: 1051425,
    durationTimescale: 1000,
    ...overrides
  } as FormatInitializationMetadata).finish());
}

/** One complete segment: header, one media chunk, end. */
function segment(options: {
  header_id: number;
  sequence_number?: number;
  is_init?: boolean;
  start_ms?: number;
  duration_ms?: number;
  data: Uint8Array;
  content_length?: number;
}): Uint8Array {
  const header = MediaHeader.encode({
    headerId: options.header_id,
    videoId: 'bUHZ2k9DYHY',
    formatId: VIDEO_FORMAT,
    itag: 401,
    isInitSeg: options.is_init ?? false,
    sequenceNumber: options.sequence_number,
    startMs: options.start_ms ?? 0,
    durationMs: options.duration_ms ?? 5000,
    contentLength: options.content_length ?? options.data.length
  } as MediaHeader).finish();

  return concat([
    umpPart(UmpPartId.MEDIA_HEADER, header),
    mediaPart(options.header_id, options.data),
    umpPart(UmpPartId.MEDIA_END, writeUmpVarInt(options.header_id))
  ]);
}

/* ---------------------------------- Die Tests --------------------------------- */

describe('SABR', () => {
  describe('UmpDecoder', () => {
    test('round-trips VarInts of every encoded width', () => {
      for (const value of [ 0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295 ]) {
        const encoded = writeUmpVarInt(value);
        expect(readUmpVarInt(encoded, 0), `value ${value}`).toEqual({ value, next: encoded.length });
      }
    });

    test('splits a response into its parts', () => {
      const decoder = new UmpDecoder();
      decoder.push(concat([
        umpPart(UmpPartId.REQUEST_IDENTIFIER, Uint8Array.from([ 1, 2, 3 ])),
        umpPart(UmpPartId.MEDIA_END, Uint8Array.from([ 7 ]))
      ]));

      const parts = [ ...decoder.parts() ].map((part) => ({ type: part.type, name: part.name, bytes: part.data.length }));

      expect(parts).toEqual([
        { type: UmpPartId.REQUEST_IDENTIFIER, name: 'REQUEST_IDENTIFIER', bytes: 3 },
        { type: UmpPartId.MEDIA_END, name: 'MEDIA_END', bytes: 1 }
      ]);
    });

    test('keeps a part that straddles two chunks', () => {
      const buffer = umpPart(UmpPartId.MEDIA, Uint8Array.from([ 9, 9, 9, 9, 9, 9 ]));
      const decoder = new UmpDecoder();

      decoder.push(buffer.subarray(0, 4));
      expect([ ...decoder.parts() ]).toHaveLength(0);
      expect(decoder.pending).toBe(4);

      decoder.push(buffer.subarray(4));
      const parts = [ ...decoder.parts() ];

      expect(parts).toHaveLength(1);
      expect(parts[0].data).toHaveLength(6);
      expect(decoder.pending).toBe(0);
    });

    test('reports a byte-by-byte feed identically to one chunk', () => {
      const buffer = concat([
        formatInit(),
        segment({ header_id: 1, is_init: true, data: new Uint8Array(40) }),
        segment({ header_id: 2, sequence_number: 1, data: new Uint8Array(1000) })
      ]);

      const decoder = new UmpDecoder();
      const types: number[] = [];

      for (const byte of buffer) {
        decoder.push(Uint8Array.from([ byte ]));

        for (const part of decoder.parts())
          types.push(part.type);
      }

      expect(types).toEqual([
        UmpPartId.FORMAT_INITIALIZATION_METADATA,
        UmpPartId.MEDIA_HEADER, UmpPartId.MEDIA, UmpPartId.MEDIA_END,
        UmpPartId.MEDIA_HEADER, UmpPartId.MEDIA, UmpPartId.MEDIA_END
      ]);
    });
  });

  describe('SabrProcessor', () => {
    test('derives the format key the way StreamingInfo does', () => {
      expect(formatKey({ itag: 401 })).toBe('401:');
      expect(formatKey({ itag: 251, xtags: 'acont=dubbed' })).toBe('251:acont=dubbed');
    });

    test('reassembles a segment from header, media chunks and end', () => {
      const processor = new SabrProcessor({ video_id: 'bUHZ2k9DYHY' });

      const header = MediaHeader.encode({
        headerId: 5,
        formatId: VIDEO_FORMAT,
        sequenceNumber: 1,
        startMs: 0,
        durationMs: 5000,
        contentLength: 9
      } as MediaHeader).finish();

      drain(processor, concat([
        formatInit(),
        umpPart(UmpPartId.MEDIA_HEADER, header),
        mediaPart(5, Uint8Array.from([ 1, 2, 3 ])),
        mediaPart(5, Uint8Array.from([ 4, 5, 6 ])),
        mediaPart(5, Uint8Array.from([ 7, 8, 9 ])),
        umpPart(UmpPartId.MEDIA_END, writeUmpVarInt(5))
      ]));

      const [ received ] = processor.drainSegments();

      expect(received.format_key).toBe(VIDEO_KEY);
      expect(received.sequence_number).toBe(1);
      expect([ ...received.data ]).toEqual([ 1, 2, 3, 4, 5, 6, 7, 8, 9 ]);
    });

    test('exposes the format metadata the playlist needs', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());

      const [ format ] = processor.drainFormats();

      expect(format.key).toBe(VIDEO_KEY);
      expect(format.total_segments).toBe(195);
      expect(format.duration_ms).toBe(1051425);
      expect(format.is_video).toBe(true);
    });

    test('rejects a segment the server cut short', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());

      expect(() => drain(processor, segment({
        header_id: 1, sequence_number: 1, data: new Uint8Array(100), content_length: 500
      }))).toThrow(SabrError);
    });

    test('rejects media for a format that was never initialized', () => {
      const processor = new SabrProcessor();

      expect(() => drain(processor, segment({ header_id: 1, sequence_number: 1, data: new Uint8Array(4) })))
        .toThrow(/uninitialized format/);
    });

    test('rejects a response about a different video', () => {
      const processor = new SabrProcessor({ video_id: 'bUHZ2k9DYHY' });

      expect(() => drain(processor, formatInit({ videoId: 'someoneelse' } as Partial<FormatInitializationMetadata>)))
        .toThrow(/wrong video/);
    });

    test('turns SABR_ERROR into a SabrError', () => {
      const processor = new SabrProcessor();
      const payload = SabrErrorMessage.encode({ type: 'SABR_ERROR', action: 2, error: { statusCode: 400 } } as SabrErrorMessage).finish();

      expect(() => drain(processor, umpPart(UmpPartId.SABR_ERROR, payload))).toThrow(SabrError);
    });

    test('picks up a redirect URL', () => {
      const processor = new SabrProcessor();
      const payload = SabrRedirect.encode({ redirectUrl: 'https://rr5---sn-x.googlevideo.com/videoplayback' }).finish();

      drain(processor, umpPart(UmpPartId.SABR_REDIRECT, payload));

      expect(processor.redirect_url).toBe('https://rr5---sn-x.googlevideo.com/videoplayback');
    });

    test('reads the attestation requirement out of the protection status', () => {
      const processor = new SabrProcessor();

      drain(processor, umpPart(UmpPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({
        status: StreamProtectionStatus_Status.ATTESTATION_REQUIRED
      } as StreamProtectionStatus).finish()));

      expect(processor.protection_status).toBe('required');
    });

    test('keeps the backoff the server asked for', () => {
      const processor = new SabrProcessor();

      drain(processor, umpPart(UmpPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({
        backoffTimeMs: 1500, playbackCookie: { resolution: 999999 }
      } as NextRequestPolicy).finish()));

      expect(processor.backoff_time_ms).toBe(1500);
    });

    test('collects unhandled part types but stays quiet about ignored ones', () => {
      const processor = new SabrProcessor();

      drain(processor, concat([
        umpPart(UmpPartId.SELECTABLE_FORMATS, Uint8Array.from([ 1 ])),
        umpPart(UmpPartId.ONESIE_HEADER, Uint8Array.from([ 1 ]))
      ]));

      expect([ ...processor.unknown_parts ]).toEqual([ 'ONESIE_HEADER' ]);
    });
  });

  describe('SabrProcessor request', () => {
    /** Pulls the request apart again, because that is what the server sees. */
    function decodeRequest(processor: SabrProcessor) {
      return VideoPlaybackAbrRequest.decode(processor.buildRequest({
        ustreamer_config: Uint8Array.from([ 1, 2, 3 ]),
        client_info: { clientName: 101, clientVersion: '1.0' },
        video_format_id: VIDEO_FORMAT
      }));
    }

    test('starts with no selected formats so the server initializes them', () => {
      const request = decodeRequest(new SabrProcessor());

      expect(request.selectedFormatIds).toEqual([]);
      expect(request.bufferedRanges).toEqual([]);
      expect(request.preferredVideoFormatIds[0].itag).toBe(401);
      expect(request.clientAbrState?.playerTimeMs).toBe(0);
      expect(request.videoPlaybackUstreamerConfig).toEqual(Uint8Array.from([ 1, 2, 3 ]));
    });

    test('reports received segments back as contiguous buffered ranges', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());

      for (let sequence = 1; sequence <= 3; sequence++) {
        drain(processor, segment({
          header_id: sequence,
          sequence_number: sequence,
          start_ms: (sequence - 1) * 5000,
          duration_ms: 5000,
          data: new Uint8Array(10)
        }));
      }

      const request = decodeRequest(processor);

      expect(request.selectedFormatIds).toHaveLength(1);
      expect(request.bufferedRanges).toHaveLength(1);
      expect(request.bufferedRanges[0]).toMatchObject({
        startTimeMs: 0, durationMs: 15000, startSegmentIndex: 1, endSegmentIndex: 3
      });
    });

    test('opens a second range when the sequence numbers jump', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());

      drain(processor, segment({ header_id: 1, sequence_number: 1, start_ms: 0, data: new Uint8Array(4) }));
      drain(processor, segment({ header_id: 2, sequence_number: 50, start_ms: 245000, data: new Uint8Array(4) }));

      expect(decodeRequest(processor).bufferedRanges).toHaveLength(2);
    });

    test('advance() moves the playhead to the end of what arrived', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());

      drain(processor, segment({ header_id: 1, sequence_number: 1, start_ms: 0, duration_ms: 5000, data: new Uint8Array(4) }));
      drain(processor, segment({ header_id: 2, sequence_number: 2, start_ms: 5000, duration_ms: 5000, data: new Uint8Array(4) }));

      expect(processor.player_time_ms).toBe(0);
      processor.advance();
      expect(processor.player_time_ms).toBe(10000);
    });

    test('advance() stops at the track that is furthest behind', () => {
      // Der Fehler vom Gerät: ein Tonsegment reicht weiter als ein Videosegment.
      // Nahm `advance()` das Maximum, sprang die Position über das noch fehlende
      // Videosegment, und der Server füllte die Lücke nie.
      const processor = new SabrProcessor();
      drain(processor, concat([ formatInit(), audioInit() ]));

      // Video bis 5392 ms, Ton bis 9920 ms.
      drain(processor, segmentOf(VIDEO_FORMAT, {
        header_id: 1, sequence_number: 1, start_ms: 0, duration_ms: 5392
      }));
      drain(processor, segmentOf(AUDIO_FORMAT, {
        header_id: 2, sequence_number: 1, start_ms: 0, duration_ms: 9920
      }));

      processor.advance();

      expect(processor.player_time_ms).toBe(5392);
    });

    test('advance() ignores a format that has delivered nothing yet', () => {
      const processor = new SabrProcessor();
      drain(processor, concat([ formatInit(), audioInit() ]));

      drain(processor, segmentOf(VIDEO_FORMAT, {
        header_id: 1, sequence_number: 1, start_ms: 0, duration_ms: 5392
      }));

      processor.advance();

      // Ohne diese Ausnahme bliebe die Position bei 0 stehen, weil der Ton noch
      // bei 0 steht — und der Strom käme nie in Gang.
      expect(processor.player_time_ms).toBe(5392);
    });

    test('advance() never moves the playhead backwards', () => {
      const processor = new SabrProcessor({ start_time_ms: 60000 });
      drain(processor, concat([ formatInit(), audioInit() ]));

      drain(processor, segmentOf(VIDEO_FORMAT, {
        header_id: 1, sequence_number: 1, start_ms: 0, duration_ms: 5392
      }));

      processor.advance();

      expect(processor.player_time_ms).toBe(60000);
    });

    test('an init segment does not advance the playhead or claim buffered time', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());
      drain(processor, segment({ header_id: 1, is_init: true, duration_ms: 0, data: new Uint8Array(40) }));

      processor.advance();

      expect(processor.player_time_ms).toBe(0);
      expect(decodeRequest(processor).bufferedRanges).toEqual([]);
    });

    test('seeking forward keeps what is buffered behind the new position', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());
      bufferSegments(processor, 4);

      processor.seek(300000);

      expect(processor.player_time_ms).toBe(300000);

      // Segments 1-4 cover 0-20 s, so they still are buffered. Reporting them
      // keeps the server from resending them if playback comes back this way.
      expect(decodeRequest(processor).bufferedRanges).toHaveLength(1);
    });

    test('seeking back behind buffered segments stops claiming them', () => {
      const processor = new SabrProcessor();
      drain(processor, formatInit());
      bufferSegments(processor, 4);

      processor.seek(2000);

      // The range spans 0-20 s and thus reaches past the new position; claiming
      // it would make the server skip the segments playback is about to need.
      expect(decodeRequest(processor).bufferedRanges).toEqual([]);
    });

    test('carries the playback cookie into the next request', () => {
      const processor = new SabrProcessor();

      drain(processor, umpPart(UmpPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({
        playbackCookie: { resolution: 999999 }
      } as NextRequestPolicy).finish()));

      expect(decodeRequest(processor).streamerContext?.playbackCookie?.length).toBeGreaterThan(0);
    });

    test('sends the PoToken as raw bytes, not as its base64 text', () => {
      const processor = new SabrProcessor({ po_token: 'MlnTAMbW-kNgn9dNC_' });
      const po_token = decodeRequest(processor).streamerContext?.poToken;

      expect(po_token).toBeInstanceOf(Uint8Array);
      expect(po_token!.length).toBe(13);
    });
  });

  describe('HLS bridge', () => {
    test('parses the sabr:// URLs StreamingInfo emits', () => {
      expect(parseSabrUrl('sabr://video?key=401:')).toEqual({ kind: 'video', key: '401:' });
      expect(parseSabrUrl('sabr://audio?key=251:acont%3Ddubbed'))
        .toEqual({ kind: 'audio', key: '251:acont=dubbed' });
      expect(parseSabrUrl('https://example.com/videoplayback')).toBeNull();
    });

    test('divides the schedule evenly when the init segment has no sidx', async () => {
      const source = {
        formats: [ { key: VIDEO_KEY, total_segments: 4, duration_ms: 20000, itag: 401, is_video: true } ],
        // Not an mp4 at all, so the sidx lookup has to fail and fall back.
        getInit: async () => new Uint8Array(16)
      };

      const index = await buildSabrHlsIndex(source as never);

      expect(index[VIDEO_KEY].durations).toEqual([ 5, 5, 5, 5 ]);
    });

    test('leaves out a format whose length it cannot work out', async () => {
      const source = {
        formats: [ { key: VIDEO_KEY, total_segments: -1, duration_ms: -1, itag: 401, is_video: true } ],
        getInit: async () => new Uint8Array(16)
      };

      expect(await buildSabrHlsIndex(source as never)).toEqual({});
    });
  });
});
