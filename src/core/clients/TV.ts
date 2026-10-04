import { HorizontalListContinuation, type IBrowseResponse, Parser } from '../../parser/index.js';
import type { Actions, Session } from '../index.js';
import type { GetVideoInfoOptions, InnerTubeClient } from '../../types/index.js';
import { generateRandomString, InnertubeError, throwIfMissing } from '../../utils/Utils.js';
import NavigationEndpoint from '../../parser/classes/NavigationEndpoint.js';
import HorizontalList from '../../parser/classes/HorizontalList.js';
import type { YTNode } from '../../parser/helpers.js';
import Playlist from '../../parser/yttv/Playlist.js';
import Library from '../../parser/yttv/Library.js';
import SubscriptionsFeed from '../../parser/yttv/SubscriptionsFeed.js';
import PlaylistsFeed from '../../parser/yttv/PlaylistsFeed.js';
import HomeFeed from '../../parser/yttv/HomeFeed.js';
import VideoInfo from '../../parser/yttv/VideoInfo.js';
import MyYoutubeFeed from '../../parser/yttv/MyYoutubeFeed.js';
import {
  resolvePlayableInfo,
  type ResolvePlayableInfoOptions,
  type ResolvedPlayableInfo
} from './PlaybackResolver.js';

export default class TV {
  #session: Session;
  readonly #actions: Actions;

  constructor(session: Session) {
    this.#session = session;
    this.#actions = session.actions;
  }

  /**
   * Retrieves video info using the TV interface.
   *
   * `/player` and `/next` are separate requests and may come from different
   * clients. That matters because the `TV` client currently answers `/player`
   * with `UNPLAYABLE` for every video — with or without authentication — while
   * its `/next` response is complete (watch next feed, transport controls).
   * Passing `player_client` keeps the TV metadata and takes the streams from a
   * client that still serves them.
   *
   * @param target - Video ID or navigation endpoint.
   * @param options - Video info options. `player_client` applies to `/player` only.
   */
  async getInfo(
    target: string | NavigationEndpoint,
    options?: Omit<GetVideoInfoOptions, 'client'> & {
      /** Client for the `/player` request. Defaults to `TV`. */
      player_client?: InnerTubeClient;
      /**
       * Whether to send the session's credentials with the `/player` request.
       * Defaults to `false` whenever `player_client` is set, because clients other
       * than TV answer authenticated requests with HTTP 400.
       */
      player_skip_auth?: boolean;
    }
  ): Promise<VideoInfo> {
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

    const extra_payload: Record<string, any> = {
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: '-1',
          signatureTimestamp: this.#session.player?.signature_timestamp
        }
      },
      client: options?.player_client ?? 'TV'
    };

    // Credentials only ever reach the TV client; anything else rejects them.
    if (options?.player_skip_auth ?? (!!options?.player_client && options.player_client !== 'TV')) {
      extra_payload.skip_auth = true;
    }

    if (options?.po_token) {
      extra_payload.serviceIntegrityDimensions = {
        poToken: options.po_token
      };
    } else if (this.#session.po_token) {
      extra_payload.serviceIntegrityDimensions = {
        poToken: this.#session.po_token
      };
    }

    const watch_response = watch_endpoint.call(this.#actions, extra_payload);

    // Stays on the TV client (and stays authenticated): this is the response the
    // TV interface is built from.
    const watch_next_response = await watch_next_endpoint.call(this.#actions, { client: 'TV' });

    const response = await Promise.all([ watch_response, watch_next_response ]);

    const cpn = generateRandomString(16);

    return new VideoInfo(response, this.#actions, cpn);
  }

  /**
   * Retrieves video info using the TV interface, trying several clients for the
   * `/player` request until one returns playable streaming data.
   *
   * This is the combination the TV interface needs: metadata and watch next data
   * from the (authenticated) TV client, streams from whichever client currently
   * serves them.
   *
   * @param target - Video ID or navigation endpoint.
   * @param options - Video info options plus the resolver's own options.
   */
  async getPlayableInfo(
    target: string | NavigationEndpoint,
    options?: Omit<GetVideoInfoOptions, 'client'> & ResolvePlayableInfoOptions<VideoInfo>
  ): Promise<ResolvedPlayableInfo<VideoInfo>> {
    throwIfMissing({ target });

    return resolvePlayableInfo<VideoInfo>(
      async (client) => this.getInfo(target, {
        player_client: client,
        po_token: (await options?.po_token_for?.(client)) ?? options?.po_token,
        player_skip_auth: options?.skip_auth
      }),
      options
    );
  }

  async getHomeFeed(): Promise<HomeFeed> {
    const client : InnerTubeClient = 'TV';
    const home_feed = new NavigationEndpoint({ browseEndpoint: {
      browseId: 'default'
    } });
    const response = await home_feed.call(this.#actions, {
      client
    });
    return new HomeFeed(response, this.#actions);
  }

  async getLibrary(): Promise<Library> {
    const browse_endpoint = new NavigationEndpoint({ browseEndpoint: { browseId: 'FElibrary' } });
    const response = await browse_endpoint.call(this.#actions, {
      client: 'TV'
    });
    return new Library(response, this.#actions);
  }
  
  async getSubscriptionsFeed(): Promise<SubscriptionsFeed> {
    const browse_endpoint = new NavigationEndpoint({ browseEndpoint: { browseId: 'FEsubscriptions' } });
    const response = await browse_endpoint.call(this.#actions, { client: 'TV' });
    return new SubscriptionsFeed(response, this.#actions);
  }

  /**
   * Retrieves the user's playlists.
   */
  async getPlaylists(): Promise<PlaylistsFeed> {
    const browse_endpoint = new NavigationEndpoint({ browseEndpoint: { browseId: 'FEplaylist_aggregation' } });
    const response = await browse_endpoint.call(this.#actions, { client: 'TV' });
    return new PlaylistsFeed(response, this.#actions);
  }

  /**
   * Retrieves the user's My YouTube page.
   */
  async getMyYoutubeFeed(): Promise<MyYoutubeFeed> {
    const browse_endpoint = new NavigationEndpoint({ browseEndpoint: { browseId: 'FEmy_youtube' } });
    const response = await browse_endpoint.call(this.#actions, { client: 'TV' });
    return new MyYoutubeFeed(response, this.#actions);
  }

  async getPlaylist(id: string): Promise<Playlist> {
    throwIfMissing({ id });

    if (!id.startsWith('VL')) {
      id = `VL${id}`;
    }

    const browse_endpoint = new NavigationEndpoint({ browseEndpoint: { browseId: id } });
    const response = await browse_endpoint.call(this.#actions, {
      client: 'TV'
    });

    return new Playlist(response, this.#actions);
  }
  
  // Utils
  
  async fetchContinuationData(item: YTNode, client?: InnerTubeClient) {
    let continuation: string | undefined;
    
    if (item.is(HorizontalList)) {
      continuation = item.continuations?.[0]?.continuation;
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