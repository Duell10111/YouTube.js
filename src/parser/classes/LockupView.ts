import { YTNode } from '../helpers.js';
import { Parser, type RawNode } from '../index.js';
import CollectionThumbnailView from './CollectionThumbnailView.js';
import LockupMetadataView from './LockupMetadataView.js';
import NavigationEndpoint from './NavigationEndpoint.js';
import ThumbnailView from './ThumbnailView.js';

export default class LockupView extends YTNode {
  static type = 'LockupView';

  content_image: CollectionThumbnailView | ThumbnailView | null;
  metadata: LockupMetadataView | null;
  content_id: string;
  content_type: 'SOURCE' | 'PLAYLIST' | 'ALBUM' | 'PODCAST' | 'SHOPPING_COLLECTION' | 'SHORT' | 'GAME' | 'PRODUCT' | 'VIDEO';
  on_tap_endpoint: NavigationEndpoint;

  constructor(data: RawNode) {
    super();

    this.content_image = Parser.parseItem(data.contentImage, [ CollectionThumbnailView, ThumbnailView ]);
    this.metadata = Parser.parseItem(data.metadata, LockupMetadataView);
    this.content_id = data.contentId;
    this.content_type = data.contentType.replace('LOCKUP_CONTENT_TYPE_', '');
    this.on_tap_endpoint = new NavigationEndpoint(data.rendererContext.commandContext.onTap);
  }
}