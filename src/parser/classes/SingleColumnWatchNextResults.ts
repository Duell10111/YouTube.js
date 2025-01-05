import type { ObservedArray } from '../helpers.js';
import { YTNode } from '../helpers.js';
import { type RawNode, Parser } from '../index.js';
import ItemSection from './ItemSection.js';
import SectionList from './SectionList.js';
import Text from './misc/Text.js';
import AutonavEndpoint from './AutonavEndpoint.js';
import MaybeHistoryEndpoint from './MaybeHistoryEndpoint.js';

export default class SingleColumnWatchNextResults extends YTNode {
  static type = 'SingleColumnWatchNextResults';

  results: {
    results: {
      contents: ObservedArray<ItemSection> | null,
      tracking_params: string
    }
  };
  autoplay: {
    autoplay: {
      sets: {
        mode: string,
        autoplay_video_renderer: AutonavEndpoint | null,
        next_video_renderer: MaybeHistoryEndpoint | null,
        previous_video_renderer: MaybeHistoryEndpoint | null
      }[],
      title: Text,
      count_down_secs: number,
      // replay_video_renderer: PivotVideo | null,
      replay_video_renderer: YTNode | null,
      tracking_params: string
    }
  };
  pivot: SectionList | null;

  constructor(data: RawNode) {
    super();
    this.results = {
      results: {
        contents: Parser.parse(data.results.results.contents, true, ItemSection),
        tracking_params: data.results.results.trackingParams
      }
    };
    this.autoplay = {
      autoplay: {
        sets: data.autoplay.autoplay.sets.map((item: any) => ({
          mode: item.mode,
          autoplay_video_renderer: Parser.parseItem(item.autoplayVideoRenderer, AutonavEndpoint),
          next_video_renderer: Parser.parseItem(item.nextVideoRenderer, MaybeHistoryEndpoint),
          previous_video_renderer: Parser.parseItem(item.previousVideoRenderer, MaybeHistoryEndpoint)
        })),
        title: new Text(data.autoplay.autoplay.title),
        count_down_secs: data.autoplay.autoplay.countDownSecs,
        replay_video_renderer: Parser.parseItem(data.autoplay.autoplay.replayVideoRenderer),
        tracking_params: data.autoplay.autoplay.trackingParams
      }
    };
    this.pivot = Parser.parseItem(data.pivot, SectionList);
  }
}