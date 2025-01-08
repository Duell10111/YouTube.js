import { Parser, SectionListContinuation } from '../index.js';

import type { IBrowseResponse } from '../types/index.js';
import type { Actions, ApiResponse } from '../../core/index.js';
import type { ObservedArray, YTNode } from '../helpers.js';
import { observe } from '../helpers.js';
import { InnertubeError } from '../../utils/Utils.js';
import SectionList from '../classes/SectionList.js';
import Shelf from '../classes/Shelf.js';

export default class Library {
  readonly #page: IBrowseResponse;
  readonly #actions: Actions;
  readonly #continuation: string | undefined;
  
  public contents?: ObservedArray<Shelf>;

  constructor(response: ApiResponse, actions: Actions) {
    this.#actions = actions;
    this.#page = Parser.parseResponse<IBrowseResponse>(response.data);

    const page = this.#page;

    const section_list = this.#page.contents_memo?.getType(SectionList)?.first();
    if (section_list) {
      this.contents = section_list.contents.filterType(Shelf);
      this.#continuation = section_list.continuation;
    }

    if (this.#page.continuation_contents) {
      const data = this.#page.continuation_contents?.as(SectionListContinuation);
      if (!data.contents) {
        throw new InnertubeError('No contents found in the response');
      }
      this.contents = data.contents.filterType(Shelf);
      this.#continuation = data.continuation ?? null;
    }
  }

  /**
   * Retrieves library items continuation.
   */
  async getContinuation(): Promise<Library> {
    if (!this.#continuation)
      throw new InnertubeError('Continuation not found.');

    const response = await this.#actions.execute('/browse', {
      client: 'TV',
      continuation: this.#continuation
    });

    return new Library(response, this.#actions);
  }

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