import { Parser, PlaylistVideoListContinuation } from '../index.js';

import { InnertubeError } from '../../utils/Utils.js';
import type { YTNode } from '../helpers.js';
import { observe, type ObservedArray } from '../helpers.js';
import type { ApiResponse, Actions } from '../../core/index.js';
import type { IBrowseResponse } from '../types/index.js';
import type MusicThumbnail from '../classes/MusicThumbnail.js';
import TwoColumn from '../classes/TwoColumn.js';
import type EntityMetadata from '../classes/EntityMetadata.js';

export default class Playlist {
  readonly #page: IBrowseResponse;
  readonly #actions: Actions;
  readonly #continuation: string | null;

  public header?: EntityMetadata;
  public contents?: ObservedArray<YTNode>;
  public background?: MusicThumbnail;

  // #last_fetched_suggestions: ObservedArray<MusicResponsiveListItem> | null;
  // #suggestions_continuation: string | null;

  constructor(response: ApiResponse, actions: Actions) {
    this.#actions = actions;
    this.#page = Parser.parseResponse<IBrowseResponse>(response.data);
    
    const page = this.#page;

    this.#continuation = null;
    
    const two_col = this.#page.contents_memo?.getType(TwoColumn)?.first();
    if (two_col) {
      this.header = two_col.left_column ?? undefined;
      
      if (two_col.right_column) {
        this.#continuation = two_col.right_column.continuation ?? null;
        this.contents = two_col.right_column.videos ?? null;
      }
    }
    
    if (this.#page.continuation_contents) {
      const data = this.#page.continuation_contents?.as(PlaylistVideoListContinuation);
      if (!data.contents) {
        throw new InnertubeError('No contents found in the response');
      }
      this.contents = data.contents;
      this.#continuation = data.continuation ?? null;
    }

    // if (this.#page.continuation_contents) {
    //   const data = this.#page.continuation_contents?.as(MusicPlaylistShelfContinuation);
    //   if (!data.contents)
    //     throw new InnertubeError('No contents found in the response');
    //   this.contents = data.contents.as(MusicResponsiveListItem);
    //   this.#continuation = data.continuation;
    // } else {
    //   if (!this.#page.contents_memo)
    //     throw new InnertubeError('No contents found in the response');
    //   this.header = this.#page.contents_memo.getType(MusicResponsiveHeader, MusicEditablePlaylistDetailHeader, MusicDetailHeader)?.first();
    //   this.contents = this.#page.contents_memo.getType(MusicPlaylistShelf)?.first()?.contents || observe([]);
    //   this.background = this.#page.background;
    //   this.#continuation = this.#page.contents_memo.getType(MusicPlaylistShelf)?.first()?.continuation || null;
    // }
  }

  /**
   * Retrieves playlist items continuation.
   */
  async getContinuation(): Promise<Playlist> {
    if (!this.#continuation)
      throw new InnertubeError('Continuation not found.');

    const response = await this.#actions.execute('/browse', {
      client: 'TV',
      continuation: this.#continuation
    });

    return new Playlist(response, this.#actions);
  }

  // /**
  //  * Retrieves related playlists
  //  */
  // async getRelated(): Promise<MusicCarouselShelf> {
  //   const target_section_list = this.#page.contents_memo?.getType(SectionList).find((section_list) => section_list.continuation);
  //
  //   if (!target_section_list)
  //     throw new InnertubeError('Could not find "Related" section.');
  //
  //   let section_continuation = target_section_list.continuation;
  //
  //   while (section_continuation) {
  //     const data = await this.#actions.execute('/browse', {
  //       client: 'YTMUSIC',
  //       continuation: section_continuation,
  //       parse: true
  //     });
  //
  //     const section_list = data.continuation_contents?.as(SectionListContinuation);
  //     const sections = section_list?.contents?.as(MusicCarouselShelf, MusicShelf);
  //
  //     const related = sections?.find((section) => section.is(MusicCarouselShelf))?.as(MusicCarouselShelf);
  //
  //     if (related)
  //       return related;
  //
  //     section_continuation = section_list?.continuation;
  //   }
  //
  //   throw new InnertubeError('Could not fetch related playlists.');
  // }

  // async getSuggestions(refresh = true): Promise<ObservedArray<MusicResponsiveListItem>> {
  //   const require_fetch = refresh || !this.#last_fetched_suggestions;
  //   const fetch_promise = require_fetch ? this.#fetchSuggestions() : Promise.resolve(null);
  //   const fetch_result = await fetch_promise;
  //
  //   if (fetch_result) {
  //     this.#last_fetched_suggestions = fetch_result.items;
  //     this.#suggestions_continuation = fetch_result.continuation;
  //   }
  //
  //   return fetch_result?.items || this.#last_fetched_suggestions || observe([]);
  // }
  //
  // async #fetchSuggestions(): Promise<{ items: ObservedArray<MusicResponsiveListItem>, continuation: string | null }> {
  //   const target_section_list = this.#page.contents_memo?.getType(SectionList).find((section_list) => section_list.continuation);
  //   const continuation = this.#suggestions_continuation || target_section_list?.continuation;
  //
  //   if (continuation) {
  //     const page = await this.#actions.execute('/browse', {
  //       client: 'YTMUSIC',
  //       continuation: continuation,
  //       parse: true
  //     });
  //
  //     const section_list = page.continuation_contents?.as(SectionListContinuation);
  //     const sections = section_list?.contents?.as(MusicCarouselShelf, MusicShelf);
  //
  //     const suggestions = sections?.find((section) => section.is(MusicShelf))?.as(MusicShelf);
  //
  //     return {
  //       items: suggestions?.contents || observe([]),
  //       continuation: suggestions?.continuation || null
  //     };
  //   }
  //
  //   return {
  //     items: observe([]),
  //     continuation: null
  //   };
  // }

  get page(): IBrowseResponse {
    return this.#page;
  }

  get items(): ObservedArray<YTNode> {
    return this.contents || observe([]);
  }

  get has_continuation(): boolean {
    return !!this.#continuation;
  }
}