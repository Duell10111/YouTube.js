import type { Actions, Session } from '../index.js';
import type { InnerTubeClient } from '../../types/index.js';
import NavigationEndpoint from '../../parser/classes/NavigationEndpoint.js';
import { HomeFeed } from '../../parser/yttv/index.js';

export default class TV {
  #session: Session;
  readonly #actions: Actions;

  constructor(session: Session) {
    this.#session = session;
    this.#actions = session.actions;
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
}