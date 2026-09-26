import * as Constants from './Constants.js';
import * as Log from './Log.js';
import { parseSidx, toByteRanges } from './Mp4SidxParser.js';
import { parseSabrUrl } from '../core/sabr/SabrSegmentSource.js';
import { getStreamingInfo } from './StreamingInfo.js';
import { InnertubeError } from './Utils.js';

import type Actions from '../core/Actions.js';
import type Player from '../core/Player.js';
import type { IStreamingData } from '../parser/index.js';
import type { FormatFilter, URLTransformer } from '../types/index.js';
import type { HlsOptions, SabrHlsOptions, SabrPlaylistIndex } from '../types/HlsOptions.js';
import type { CaptionTrackData } from '../parser/classes/PlayerCaptionsTracklist.js';
import type { AudioRepresentation, AudioSet, SegmentInfo, VideoRepresentation, VideoSet } from './StreamingInfo.js';
import type { ByteRange } from './Mp4SidxParser.js';

const TAG_ = 'HlsManifest';

/**
 * A generated HLS presentation.
 *
 * HLS is a multi-file format: the master playlist points at one media playlist
 * per rendition. Write all of them into the same directory (or serve them from
 * the same path) — the master references the others by the `name` given here.
 */
export interface HlsManifest {
  master: string;
  playlists: HlsMediaPlaylist[];
}

export interface HlsMediaPlaylist {
  /** File name the master playlist refers to, e.g. `video-401.m3u8`. */
  name: string;
  content: string;
}

/**
 * Video codecs to offer, safest first.
 *
 * `avc1` leads on purpose: it is the only family every Apple device decodes, and
 * it becomes the base ladder. `av01` follows and contributes the heights avc1
 * cannot reach (YouTube caps avc1 at 1080p), so 1440p/2160p stay available to
 * hardware that can decode them — Apple TV 4K (3rd gen) and newer.
 *
 * Pass `[ 'avc1' ]` to leave AV1 out entirely; that is the right call wherever
 * the decoder is unknown.
 */
const DEFAULT_CODEC_PREFERENCE = [ 'avc1', 'av01' ];

/**
 * Only fragmented mp4 carries a `sidx` box. VP9 lives in WebM, which indexes
 * through cues instead — and AVPlayer cannot decode it anyway.
 */
function isUsableMimeType(mime_type: string): boolean {
  return mime_type.startsWith('video/mp4') || mime_type.startsWith('audio/mp4');
}

function codecFamily(codecs?: string): string {
  return codecs?.split('.')[0] ?? '';
}

/**
 * The byte-range form of HLS needs `base_url`, `init_range` and `index_range`.
 * OTF and Post Live DVR formats describe themselves through segment templates
 * instead; YouTube serves its own HLS manifest for those.
 */
function isIndexed(segment_info: SegmentInfo): segment_info is Extract<SegmentInfo, { is_oft: false, is_post_live_dvr: false }> {
  return !segment_info.is_oft && !segment_info.is_post_live_dvr;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * Loads a rendition's segment schedule.
 *
 * One range request per rendition (a few KB), so the selection has to be made
 * before this is called — see `pickVideoRenditions`.
 */
async function getByteRanges(
  segment_info: Extract<SegmentInfo, { is_oft: false, is_post_live_dvr: false }>,
  actions: Actions
): Promise<ByteRange[]> {
  const response = await actions.session.http.fetch_function(segment_info.base_url, {
    method: 'GET',
    headers: {
      ...Constants.STREAM_HEADERS,
      Range: `bytes=${segment_info.index_range.start}-${segment_info.index_range.end}`
    }
  });

  if (!response.ok)
    throw new InnertubeError(`Could not read the segment index: HTTP ${response.status}`);

  const sidx = parseSidx(new Uint8Array(await response.arrayBuffer()));

  return toByteRanges(sidx, segment_info.index_range.end);
}

function renderMediaPlaylist(
  segment_info: Extract<SegmentInfo, { is_oft: false, is_post_live_dvr: false }>,
  ranges: ByteRange[]
): string {
  const target_duration = Math.ceil(Math.max(...ranges.map((range) => range.duration)));
  const init = segment_info.init_range;

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${target_duration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI=${quote(segment_info.base_url)},BYTERANGE="${init.end - init.start + 1}@${init.start}"`
  ];

  for (const range of ranges) {
    lines.push(`#EXTINF:${range.duration.toFixed(5)},`);
    lines.push(`#EXT-X-BYTERANGE:${range.length}@${range.offset}`);
    lines.push(segment_info.base_url);
  }

  lines.push('#EXT-X-ENDLIST');

  return `${lines.join('\n')}\n`;
}

/**
 * The `segments`-mode media playlist: one numbered URL per segment.
 *
 * SABR has no byte ranges to point at — the server decides what to send and
 * addresses it by sequence number — so the playlist names segments the same way
 * and a local server turns each request back into a SABR pull.
 *
 * Sequence numbers are 1-based, which is why `EXT-X-MEDIA-SEQUENCE` is `1`: the
 * number in the URL is then the number SABR uses, with nothing to translate.
 */
function renderSegmentPlaylist(format_key: string, index: SabrPlaylistIndex, base_url: string): string {
  const prefix = `${base_url.replace(/\/$/, '')}/${encodeURIComponent(format_key)}`;
  const target_duration = Math.ceil(Math.max(...index.durations));

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${target_duration}`,
    '#EXT-X-MEDIA-SEQUENCE:1',
    `#EXT-X-MAP:URI=${quote(`${prefix}/init.mp4`)}`
  ];

  index.durations.forEach((duration, position) => {
    lines.push(`#EXTINF:${duration.toFixed(5)},`);
    lines.push(`${prefix}/${position + 1}.m4s`);
  });

  lines.push('#EXT-X-ENDLIST');

  return `${lines.join('\n')}\n`;
}

interface SelectedVideo {
  set: VideoSet;
  representation: VideoRepresentation;
  name: string;
}

interface SelectedAudio {
  set: AudioSet;
  representation: AudioRepresentation;
  name: string;
  /** Group the variants point at through `AUDIO=`. */
  group_id: string;
  is_default: boolean;
}

/**
 * Chooses which video renditions end up in the manifest.
 *
 * **A codec family is never dropped entirely.** An earlier version kept one
 * rendition per height and let the codec preference decide the winner — which
 * produced manifests made up exclusively of AV1, because YouTube offers av01 at
 * every height. A player without an AV1 decoder then has nothing it can select:
 * on the tvOS simulator that ends in a stalled player and a dead media services
 * process, no error delivered. Only Apple TV 4K (3rd gen) decodes AV1 in
 * hardware.
 *
 * So the ladder is built from the **first** preferred family that has
 * renditions, and the other families only contribute heights that family cannot
 * reach — which is exactly the 1440p/2160p that YouTube ships as av01 only.
 *
 * Every rendition costs one index request at start-up, hence the budget.
 */
function pickVideoRenditions(video_sets: VideoSet[], options: HlsOptions): SelectedVideo[] {
  const codec_preference = options.codec_preference ?? DEFAULT_CODEC_PREFERENCE;
  const max_height = options.max_height ?? Infinity;

  /** family -> height -> best rendition of that height */
  const by_family = new Map<string, Map<number, SelectedVideo>>();

  for (const set of video_sets) {
    if (!isUsableMimeType(set.mime_type))
      continue;

    for (const representation of set.representations) {
      if (!isIndexed(representation.segment_info))
        continue;

      const family = codecFamily(representation.codecs ?? set.codecs);

      if (!codec_preference.includes(family))
        continue;

      if ((representation.height ?? 0) > max_height)
        continue;

      const candidate: SelectedVideo = {
        set,
        representation,
        name: `video-${sanitize(representation.uid)}.m3u8`
      };

      const heights = by_family.get(family) ?? new Map<number, SelectedVideo>();
      const height = representation.height ?? 0;
      const current = heights.get(height);

      if (!current || candidate.representation.bitrate > current.representation.bitrate)
        heights.set(height, candidate);

      by_family.set(family, heights);
    }
  }

  const ladder = (family: string) =>
    [ ...(by_family.get(family)?.values() ?? []) ]
      .sort((a, b) => (b.representation.height ?? 0) - (a.representation.height ?? 0));

  const primary_family = codec_preference.find((family) => by_family.has(family));

  if (!primary_family)
    return [];

  const primary = thinOut(ladder(primary_family), options.max_video_renditions ?? 6);
  const reach = Math.max(...primary.map((entry) => entry.representation.height ?? 0));

  // Higher resolutions the primary codec does not offer — YouTube caps avc1 at
  // 1080p, so this is where 1440p and 2160p come from. Deliberately few: a
  // player that cannot decode them must not end up with a ladder full of them.
  const extras: SelectedVideo[] = [];

  for (const family of codec_preference) {
    if (family === primary_family)
      continue;

    for (const entry of ladder(family)) {
      if ((entry.representation.height ?? 0) > reach && extras.length < 2)
        extras.push(entry);
    }
  }

  // The primary ladder comes first so a player that simply starts at the top of
  // the list starts on something it can decode.
  return [ ...primary, ...extras ];
}

/**
 * Trims a ladder to `limit` entries, thinning out the middle rather than the
 * ends — the highest quality and a low fallback are the two that matter.
 */
function thinOut(ladder: SelectedVideo[], limit: number): SelectedVideo[] {
  if (ladder.length <= limit)
    return ladder;

  const kept = [ ladder[0] ];
  const step = (ladder.length - 1) / (limit - 1);

  for (let i = 1; i < limit; i++)
    kept.push(ladder[Math.round(i * step)]);

  return [ ...new Set(kept) ];
}

/**
 * One rendition per audio track: the highest bitrate mp4 stream of each
 * language/variant. Several bitrates of the same language would need a group of
 * their own, which no player benefits from here.
 */
function pickAudioRenditions(audio_sets: AudioSet[]): SelectedAudio[] {
  const selected: SelectedAudio[] = [];

  for (const set of audio_sets) {
    if (!isUsableMimeType(set.mime_type))
      continue;

    const representation = set.representations
      .filter((candidate) => isIndexed(candidate.segment_info))
      .sort((a, b) => b.bitrate - a.bitrate)[0];

    if (!representation)
      continue;

    selected.push({
      set,
      representation,
      name: `audio-${sanitize(representation.uid)}.m3u8`,
      group_id: 'audio',
      is_default: set.track_roles?.includes('main') ?? false
    });
  }

  // HLS wants exactly one default rendition per group.
  if (selected.length && !selected.some((entry) => entry.is_default))
    selected[0].is_default = true;

  let seen_default = false;

  for (const entry of selected) {
    if (entry.is_default && seen_default)
      entry.is_default = false;
    else if (entry.is_default)
      seen_default = true;
  }

  return selected;
}

function renderMaster(videos: SelectedVideo[], audios: SelectedAudio[]): string {
  const lines = [ '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS' ];

  for (const audio of audios) {
    const attributes = [
      'TYPE=AUDIO',
      `GROUP-ID=${quote(audio.group_id)}`,
      `NAME=${quote(audio.set.track_name ?? audio.set.language ?? 'Audio')}`,
      `DEFAULT=${audio.is_default ? 'YES' : 'NO'}`,
      `AUTOSELECT=${audio.is_default ? 'YES' : 'NO'}`,
      `CHANNELS=${quote(String(audio.representation.channels ?? audio.set.channels ?? 2))}`
    ];

    if (audio.set.language)
      attributes.splice(3, 0, `LANGUAGE=${quote(audio.set.language)}`);

    attributes.push(`URI=${quote(audio.name)}`);

    lines.push(`#EXT-X-MEDIA:${attributes.join(',')}`);
  }

  const audio_group = audios.length ? audios[0].group_id : undefined;
  // The variant's declared bandwidth has to cover audio too, otherwise the
  // player underestimates what it is about to load.
  const audio_bitrate = audios.length ? Math.max(...audios.map((audio) => audio.representation.bitrate)) : 0;
  const audio_codecs = audios.length ? (audios[0].representation.codecs ?? audios[0].set.codecs) : undefined;

  for (const video of videos) {
    const codecs = [ video.representation.codecs ?? video.set.codecs, audio_codecs ].filter(Boolean).join(',');

    const attributes = [ `BANDWIDTH=${video.representation.bitrate + audio_bitrate}` ];

    if (codecs)
      attributes.push(`CODECS=${quote(codecs)}`);

    if (video.representation.width && video.representation.height)
      attributes.push(`RESOLUTION=${video.representation.width}x${video.representation.height}`);

    const fps = video.representation.fps ?? video.set.fps;

    if (fps)
      attributes.push(`FRAME-RATE=${fps}`);

    if (audio_group)
      attributes.push(`AUDIO=${quote(audio_group)}`);

    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(video.name);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Drops every representation the SABR stream did not initialize.
 *
 * The sets come from the whole player response, while a SABR stream holds only
 * the formats it asked for. Whatever is left over has no segment index and no
 * way to be served, so it must not reach the manifest.
 */
function restrictToSabrIndex<T extends VideoSet | AudioSet>(sets: T[], sabr: SabrHlsOptions): T[] {
  return sets
    .map((set) => ({
      ...set,
      representations: set.representations.filter((representation) => {
        if (!isIndexed(representation.segment_info))
          return false;

        const parsed = parseSabrUrl(representation.segment_info.base_url);

        return !!parsed && !!sabr.index[parsed.key]?.durations.length;
      })
    } as T))
    .filter((set) => set.representations.length > 0);
}

/**
 * Builds an HLS presentation from the adaptive formats.
 *
 * **Why this exists next to YouTube's own HLS manifest:** YouTube only offers
 * avc1 up to 1080p there, with the audio muxed in — no 2160p, no language
 * selection. The adaptive formats carry both, but AVPlayer cannot read a DASH
 * `SegmentBase` index the way ExoPlayer does, so the segment list has to be
 * spelled out. That is what this does: one index request per rendition, the
 * `sidx` box parsed into `EXT-X-BYTERANGE` entries.
 *
 * **Client matters.** Byte-range delivery of adaptive formats is capped for most
 * InnerTube clients — after roughly 0.37 MB googlevideo answers 403. Measured
 * (see `docs/byte-range-cap.md`), `VISIONOS` is served in full while `IOS`,
 * `TV_SIMPLY` and `ANDROID_VR` are capped. Feed this function streaming data
 * from a client that is not capped.
 */
export async function toHLS(
  streaming_data?: IStreamingData,
  is_post_live_dvr = false,
  url_transformer: URLTransformer = (url) => url,
  format_filter?: FormatFilter,
  cpn?: string,
  player?: Player,
  actions?: Actions,
  caption_tracks?: CaptionTrackData[],
  options: HlsOptions = {}
): Promise<HlsManifest> {
  if (!streaming_data)
    throw new InnertubeError('Streaming data not available');

  if (is_post_live_dvr)
    throw new InnertubeError('Post Live DVR videos are not supported. Use the HLS manifest provided by YouTube in `streaming_data.hls_manifest_url` instead.');

  // Only the byte-range path fetches indexes; in segments mode the schedule
  // comes out of the SABR stream, so an Actions instance is not needed for that.
  if (!actions && options.mode !== 'segments')
    throw new InnertubeError('An Actions instance is required to read the segment indexes');

  const is_segments = options.mode === 'segments';

  if (options.mode && options.mode !== 'byterange' && !is_segments)
    throw new InnertubeError(`Unsupported mode: ${options.mode}. Use 'byterange' or 'segments'.`);

  if (is_segments && !options.sabr)
    throw new InnertubeError('Mode \'segments\' needs `sabr` with a base URL and a segment index. Build the index with buildSabrHlsIndex().');

  // In segments mode the format URLs have to be the `sabr://` form, because the
  // format key in them is what pairs a rendition with its entry in the index.
  // Setting it here rather than trusting the caller keeps the two in step.
  const { video_sets, audio_sets } = await getStreamingInfo(
    streaming_data,
    false,
    url_transformer,
    format_filter,
    cpn,
    player,
    actions,
    undefined,
    caption_tracks,
    is_segments ? { ...options, is_sabr: true } : options
  );

  // With SABR the server does the adapting, and one stream carries exactly the
  // formats it was asked for — so a segments-mode manifest offers those and
  // nothing else. Keeping the full ladder would name renditions no segment
  // request could ever be answered for. `codec_preference`, `max_height` and
  // `max_video_renditions` therefore have no effect in this mode; choose the
  // codec when selecting the formats for the SabrStream instead.
  const usable_video_sets = is_segments ? restrictToSabrIndex(video_sets, options.sabr!) : video_sets;
  const usable_audio_sets = is_segments ? restrictToSabrIndex(audio_sets, options.sabr!) : audio_sets;

  const videos = pickVideoRenditions(usable_video_sets, options);
  const audios = pickAudioRenditions(usable_audio_sets);

  if (!videos.length)
    throw new InnertubeError('No usable video renditions. The formats are either SABR-only, not mp4, or carry no segment index.');

  if (!audios.length)
    throw new InnertubeError('No usable audio renditions. The formats are either SABR-only, not mp4, or carry no segment index.');

  Log.info(TAG_, `Building HLS for ${videos.length} video and ${audios.length} audio renditions`);

  const entries = [
    ...videos.map((video) => ({ name: video.name, segment_info: video.representation.segment_info })),
    ...audios.map((audio) => ({ name: audio.name, segment_info: audio.representation.segment_info }))
  ];

  const playlists = await Promise.all(entries.map(async (entry) => {
    if (!isIndexed(entry.segment_info))
      throw new InnertubeError('Selected a rendition without a segment index');

    if (is_segments) {
      const sabr = options.sabr!;
      const parsed = parseSabrUrl(entry.segment_info.base_url);

      if (!parsed)
        throw new InnertubeError(`Expected a sabr:// URL in segments mode, got ${entry.segment_info.base_url}`);

      const index = sabr.index[parsed.key];

      if (!index?.durations.length)
        throw new InnertubeError(`No segment index for format ${parsed.key}. The SABR stream did not initialize it.`);

      return { name: entry.name, content: renderSegmentPlaylist(parsed.key, index, sabr.base_url) };
    }

    const ranges = await getByteRanges(entry.segment_info, actions!);

    return { name: entry.name, content: renderMediaPlaylist(entry.segment_info, ranges) };
  }));

  return { master: renderMaster(videos, audios), playlists };
}
