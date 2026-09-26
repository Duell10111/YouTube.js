import { YTNode } from '../helpers.js';
import { Parser, type RawNode } from '../index.js';
import ThumbnailView from './ThumbnailView.js';
import CollectionThumbnailView from './CollectionThumbnailView.js';
import LockupMetadataView from './LockupMetadataView.js';
import RendererContext from './misc/RendererContext.js';

export type LockupContentType = 'UNSPECIFIED' | 'VIDEO' | 'PLAYLIST' | 'SHORT' | 'CHANNEL' | 'ALBUM' |
  'PRODUCT' | 'GAME' | 'CLIP' | 'PODCAST' | 'SOURCE' | 'SHOPPING_COLLECTION' | 'MOVIE' | 'STATION' | 'SHOW';

export interface LockupStyling {
  /** `VERTICAL` or `HORIZONTAL`, with the `LOCKUP_LAYOUT_` prefix stripped. */
  layout?: string;
  /** e.g. `WIDESCREEN`, with the `LOCKUP_CONTENT_IMAGE_ASPECT_RATIO_` prefix stripped. */
  content_image_aspect_ratio?: string;
}

export default class LockupView extends YTNode {
  static type = 'LockupView';

  public content_image: CollectionThumbnailView | ThumbnailView | null;
  public metadata: LockupMetadataView | null;
  /**
   * Both absent on the horizontal lockup the TV client puts in a video's
   * description — it points at a playlist through its metadata instead of
   * carrying an id of its own. Reading `contentType` unconditionally made that
   * node throw, so it was dropped from the response entirely.
   */
  public content_id?: string;
  public content_type?: LockupContentType;
  /** Layout hints. Observed on the TV client; absent on web. */
  public styling?: LockupStyling;
  public renderer_context: RendererContext;

  constructor(data: RawNode) {
    super();
    this.content_image = Parser.parseItem(data.contentImage, [ CollectionThumbnailView, ThumbnailView ]);
    this.metadata = Parser.parseItem(data.metadata, LockupMetadataView);

    if (Reflect.has(data, 'contentId')) {
      this.content_id = data.contentId;
    }

    if (Reflect.has(data, 'contentType')) {
      this.content_type = data.contentType.replace('LOCKUP_CONTENT_TYPE_', '');
    }

    if (Reflect.has(data, 'styling')) {
      this.styling = {
        layout: data.styling.layout?.replace('LOCKUP_LAYOUT_', ''),
        content_image_aspect_ratio: data.styling.contentImageAspectRatio?.replace('LOCKUP_CONTENT_IMAGE_ASPECT_RATIO_', '')
      };
    }

    this.renderer_context = new RendererContext(data.rendererContext);
  }
}