import { HorizontalListContinuation, type IBrowseResponse } from '../../parser/index.js';
import { Parser } from '../../parser/index.js';
import type { Actions, Session } from '../index.js';
import type { InnerTubeClient } from '../../types/index.js';
import NavigationEndpoint from '../../parser/classes/NavigationEndpoint.js';
import { HomeFeed, VideoInfo } from '../../parser/yttv/index.js';
import { generateRandomString, InnertubeError, throwIfMissing } from '../../utils/Utils.js';
import HorizontalList from '../../parser/classes/HorizontalList.js';
import type { YTNode } from '../../parser/helpers.js';

export default class TV {
  #session: Session;
  readonly #actions: Actions;

  constructor(session: Session) {
    this.#session = session;
    this.#actions = session.actions;
  }

  async getInfo(target: string | NavigationEndpoint, client?: InnerTubeClient): Promise<VideoInfo> {
    throwIfMissing({ target });

    const payload = {
      videoId: target instanceof NavigationEndpoint ? target.payload?.videoId : target,
      playlistId: target instanceof NavigationEndpoint ? target.payload?.playlistId : undefined,
      playlistIndex: target instanceof NavigationEndpoint ? target.payload?.playlistIndex : undefined,
      params: target instanceof NavigationEndpoint ? target.payload?.params : undefined,
      racyCheckOk: true,
      contentCheckOk: true
    };

    const watch_endpoint = new NavigationEndpoint({ watchEndpoint: payload });
    const watch_next_endpoint = new NavigationEndpoint({ watchNextEndpoint: payload });

    const watch_response = watch_endpoint.call(this.#session.actions, {
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: '-1',
          signatureTimestamp: this.#session.player?.sts
        }
      },
      serviceIntegrityDimensions: {
        poToken: this.#session.po_token
      },
      client
    });

    const watch_next_response = await watch_next_endpoint.call(this.#session.actions, {
      client
    });

    const response = await Promise.all([ watch_response, watch_next_response ]);

    const cpn = generateRandomString(16);

    return new VideoInfo(response, this.#actions, cpn);
  }

  async getHomeFeed(): Promise<HomeFeed> {
    const client : InnerTubeClient = 'TV';
    const home_feed = new NavigationEndpoint({ browseEndpoint: {
      browseId: 'default'
    } });
    const response = await home_feed.call(this.#session.actions, {
      client
    });
    return new HomeFeed(response, this.#actions);
  }
  
  async fetchContinuationData(item: YTNode, client?: InnerTubeClient) {
    let continuation: string | undefined;
    
    if (item.is(HorizontalList)) {
      continuation = item.continuations?.first()?.continuation;
    } else if (item.is(HorizontalListContinuation)) {
      continuation = item.continuation;
    } else {
      throw new InnertubeError(`No supported YTNode supplied. Type: ${item.type}`);
    }
    
    if (!continuation) {
      throw new InnertubeError('No continuation data available.');
    }
    
    const data = await this.#actions.execute('/browse', {
      client: client ?? 'TV',
      continuation: continuation
    });

    const parser = Parser.parseResponse<IBrowseResponse>(data.data);
    return parser.continuation_contents;
  }
}