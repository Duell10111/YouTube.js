import { MediaInfo } from '../../core/mixins/index.js';
import { Constants } from '../../utils/index.js';

import type ChipCloud from '../classes/ChipCloud.js';
import type CommentsEntryPointHeader from '../classes/comments/CommentsEntryPointHeader.js';
import type ContinuationItem from '../classes/ContinuationItem.js';
import ItemSection from '../classes/ItemSection.js';
import type LiveChat from '../classes/LiveChat.js';
import type MerchandiseShelf from '../classes/MerchandiseShelf.js';
import PlayerOverlay from '../classes/PlayerOverlay.js';
import type VideoSecondaryInfo from '../classes/VideoSecondaryInfo.js';
import NavigationEndpoint from '../classes/NavigationEndpoint.js';

import type { Actions, ApiResponse } from '../../core/index.js';
import type { ObservedArray, YTNode } from '../helpers.js';
import SingleColumnWatchNextResults from '../classes/SingleColumnWatchNextResults.js';
import VideoMetadata from '../classes/VideoMetadata.js';
import { InnertubeError } from '../../utils/Utils.js';

export default class VideoInfo extends MediaInfo {
  public primary_info?: VideoMetadata | null;
  public secondary_info?: VideoSecondaryInfo | null;
  public playlist?: SingleColumnWatchNextResults['playlist'];
  public merchandise?: MerchandiseShelf | null;
  public related_chip_cloud?: ChipCloud | null;
  public watch_next_feed?: ObservedArray<YTNode> | null;
  public player_overlays?: PlayerOverlay | null;
  public comments_entry_point_header?: CommentsEntryPointHeader | null;
  public livechat?: LiveChat | null;
  public autoplay?: SingleColumnWatchNextResults['autoplay']['autoplay'];

  #watch_next_continuation?: ContinuationItem;
  
  constructor(data: [ApiResponse, ApiResponse?], actions: Actions, cpn: string) {
    super(data, actions, cpn);

    const [ info, next ] = this.page;

    if (this.streaming_data) {
      const default_audio_track = this.streaming_data.adaptive_formats.find((format) => format.audio_track?.audio_is_default);
      if (default_audio_track) {
        // The combined formats only exist for the default language, even for videos with multiple audio tracks
        // So we can copy the language from the default audio track to the combined formats
        this.streaming_data.formats.forEach((format) => format.language = default_audio_track.language);
      } else if (this.captions?.caption_tracks && this.captions?.caption_tracks.length > 0) {
        // For videos with a single audio track and captions, we can use the captions to figure out the language of the audio and combined formats
        const auto_generated_caption_track = this.captions.caption_tracks.find((caption) => caption.kind === 'asr');
        const language_code = auto_generated_caption_track?.language_code;

        this.streaming_data.adaptive_formats.forEach((format) => {
          if (format.has_audio) {
            format.language = language_code;
          }
        });
        this.streaming_data.formats.forEach((format) => format.language = language_code);
      }
    }

    const single_col = next?.contents?.item()?.as(SingleColumnWatchNextResults);

    const results = single_col?.results?.results?.contents;
    // const secondary_results = two_col?.secondary_results;
    
    if (single_col) {
      this.watch_next_feed = single_col.pivot?.contents;
      
      this.autoplay = single_col.autoplay.autoplay;

      this.player_overlays = next?.player_overlays?.item().as(PlayerOverlay);

      if (single_col?.playlist) {
        this.playlist = single_col.playlist;
      }
    }

    if (results) {
      // if (info.microformat?.is(PlayerMicroformat) && info.microformat?.category === 'Gaming') {
      //   const row = results.firstOfType(VideoSecondaryInfo)?.metadata?.rows?.firstOfType(RichMetadataRow);
      //   if (row?.is(RichMetadataRow)) {
      //     this.game_info = {
      //       title: row?.contents?.firstOfType(RichMetadata)?.title,
      //       release_year: row?.contents?.firstOfType(RichMetadata)?.subtitle
      //     };
      //   }
      // }

      this.primary_info = results.firstOfType(ItemSection)?.contents?.firstOfType(VideoMetadata);
      this.basic_info.title = this.primary_info?.title.text;
      this.basic_info.short_description = this.primary_info?.description.text;
      // this.basic_info.view_count = this.primary_info?.view_count?.view_count?.text;
      
      this.basic_info.author = this.primary_info?.owner?.author.name;
      this.basic_info.channel = this.primary_info?.owner?.author ? {
        id: this.primary_info.owner.author.id,
        name: this.primary_info.owner.author.name,
        url: this.primary_info.owner.author.best_thumbnail!.url
      } : null;
      
      this.basic_info.like_count = this.primary_info?.like_button?.like_count;
      this.basic_info.is_liked = this.primary_info?.like_button?.like_status === 'LIKE'; // TODO: Adapt once value known
      this.basic_info.is_disliked = this.primary_info?.like_button?.like_status === 'DISLIKE'; // TODO: Adapt once value known
      this.basic_info.allow_ratings = this.primary_info?.allow_ratings;

      // this.watch_next_feed = secondary_results.firstOfType(ItemSection)?.contents || secondary_results;
      //
      // if (this.watch_next_feed && Array.isArray(this.watch_next_feed) && this.watch_next_feed.at(-1)?.is(ContinuationItem))
      //   this.#watch_next_continuation = this.watch_next_feed.pop()?.as(ContinuationItem);
      //
      // this.player_overlays = next?.player_overlays?.item().as(PlayerOverlay);
      //
      // if (two_col?.autoplay) {
      //   this.autoplay = two_col.autoplay;
      // }
      //
      // const segmented_like_dislike_button = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButton);
      //
      // if (segmented_like_dislike_button?.like_button?.is(ToggleButton) && segmented_like_dislike_button?.dislike_button?.is(ToggleButton)) {
      //   this.basic_info.like_count = segmented_like_dislike_button?.like_button?.like_count;
      //   this.basic_info.is_liked = segmented_like_dislike_button?.like_button?.is_toggled;
      //   this.basic_info.is_disliked = segmented_like_dislike_button?.dislike_button?.is_toggled;
      // }
      //
      // const segmented_like_dislike_button_view = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButtonView);
      // if (segmented_like_dislike_button_view) {
      //   this.basic_info.like_count = segmented_like_dislike_button_view.like_count;
      //
      //   if (segmented_like_dislike_button_view.like_button) {
      //     const like_status = segmented_like_dislike_button_view.like_button.like_status_entity.like_status;
      //     this.basic_info.is_liked = like_status === 'LIKE';
      //     this.basic_info.is_disliked = like_status === 'DISLIKE';
      //   }
      // }
      //
      // const comments_entry_point = results.get({ target_id: 'comments-entry-point' })?.as(ItemSection);
      //
      // this.comments_entry_point_header = comments_entry_point?.contents?.firstOfType(CommentsEntryPointHeader);
      // this.livechat = next?.contents_memo?.getType(LiveChat).first();
    }
  }

  /**
   * Adds video to the watch history with specific point.
   */
  async addToWatchHistorySeconds(playedSeconds = 0): Promise<Response> {
    return super.addToWatchHistory(Constants.CLIENTS.TV.NAME, Constants.CLIENTS.TV.VERSION, undefined, playedSeconds);
  }

  /**
   * Adds video to the watch history.
   */
  async addToWatchHistory(): Promise<Response> {
    return this.addToWatchHistorySeconds();
  }

  /**
   * Likes the video.
   */
  async like(): Promise<ApiResponse> {
    const videoId = this.primary_info?.video_id;
    
    if (!videoId) {
      throw new InnertubeError('No videoId found!');
    }
    
    if (!this.actions.session.logged_in)
      throw new Error('You must be signed in to perform this operation.');

    const like_endpoint = new NavigationEndpoint({
      likeEndpoint: {
        status: 'LIKE',
        target: videoId
      }
    });

    return like_endpoint.call(this.actions, { client: 'TV' });
  }

  // /**
  //  * Dislikes the video.
  //  */
  // async dislike(): Promise<ApiResponse> {
  //   const segmented_like_dislike_button_view = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButtonView);
  //
  //   if (segmented_like_dislike_button_view) {
  //     const button = segmented_like_dislike_button_view?.dislike_button?.toggle_button;
  //
  //     if (!button || !button.default_button || !segmented_like_dislike_button_view.dislike_button || !segmented_like_dislike_button_view.like_button)
  //       throw new InnertubeError('Dislike button not found', { video_id: this.basic_info.id });
  //
  //     const like_status = segmented_like_dislike_button_view.like_button.like_status_entity.like_status;
  //
  //     if (like_status === 'DISLIKE')
  //       throw new InnertubeError('This video is already disliked', { video_id: this.basic_info.id });
  //
  //     const endpoint = new NavigationEndpoint(button.default_button.on_tap.payload.commands.find((cmd: RawNode) => cmd.innertubeCommand));
  //
  //     return await endpoint.call(this.actions);
  //   }
  //
  //   const segmented_like_dislike_button = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButton);
  //   const button = segmented_like_dislike_button?.dislike_button;
  //
  //   if (!button)
  //     throw new InnertubeError('Dislike button not found', { video_id: this.basic_info.id });
  //
  //   if (!button.is(ToggleButton))
  //     throw new InnertubeError('Dislike button is not a toggle button. This action is likely disabled for this video.', { video_id: this.basic_info.id });
  //
  //   if (button.is_toggled)
  //     throw new InnertubeError('This video is already disliked', { video_id: this.basic_info.id });
  //
  //   return await button.endpoint.call(this.actions);
  // }
  //
  // /**
  //  * Removes like/dislike.
  //  */
  // async removeRating(): Promise<ApiResponse> {
  //   let button;
  //
  //   const segmented_like_dislike_button_view = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButtonView);
  //
  //   if (segmented_like_dislike_button_view) {
  //     const toggle_button = segmented_like_dislike_button_view?.like_button?.toggle_button;
  //
  //     if (!toggle_button || !toggle_button.default_button || !segmented_like_dislike_button_view.like_button)
  //       throw new InnertubeError('Like button not found', { video_id: this.basic_info.id });
  //
  //     const like_status = segmented_like_dislike_button_view.like_button.like_status_entity.like_status;
  //
  //     if (like_status === 'LIKE') {
  //       button = segmented_like_dislike_button_view?.like_button?.toggle_button;
  //     } else if (like_status === 'DISLIKE') {
  //       button = segmented_like_dislike_button_view?.dislike_button?.toggle_button;
  //     } else {
  //       throw new InnertubeError('This video is not liked/disliked', { video_id: this.basic_info.id });
  //     }
  //
  //     if (!button || !button.toggled_button)
  //       throw new InnertubeError('Like/Dislike button not found', { video_id: this.basic_info.id });
  //
  //     const endpoint = new NavigationEndpoint(button.toggled_button.on_tap.payload.commands.find((cmd: RawNode) => cmd.innertubeCommand));
  //
  //     return await endpoint.call(this.actions);
  //   }
  //
  //   const segmented_like_dislike_button = this.primary_info?.menu?.top_level_buttons.firstOfType(SegmentedLikeDislikeButton);
  //
  //   const like_button = segmented_like_dislike_button?.like_button;
  //   const dislike_button = segmented_like_dislike_button?.dislike_button;
  //
  //   if (!like_button?.is(ToggleButton) || !dislike_button?.is(ToggleButton))
  //     throw new InnertubeError('Like/Dislike button is not a toggle button. This action is likely disabled for this video.', { video_id: this.basic_info.id });
  //
  //   if (like_button?.is_toggled) {
  //     button = like_button;
  //   } else if (dislike_button?.is_toggled) {
  //     button = dislike_button;
  //   }
  //
  //   if (!button)
  //     throw new InnertubeError('This video is not liked/disliked', { video_id: this.basic_info.id });
  //
  //   return await button.toggled_endpoint.call(this.actions);
  // }

  /**
   * Gets the endpoint of the autoplay video
   */
  get autoplay_video_endpoint(): NavigationEndpoint | null {
    return this.autoplay?.sets?.[0]?.autoplay_video_renderer?.endpoint || null;
  }
}