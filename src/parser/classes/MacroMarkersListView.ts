import { YTNode } from '../helpers.js';
import { type RawNode } from '../index.js';
import RendererContext from './misc/RendererContext.js';
import Text from './misc/Text.js';

/**
 * The chapters list, in its view-model form.
 *
 * Appears in two shapes, and both have to parse:
 *
 * - **As the content of an engagement panel** — no `title` and no
 *   `rendererContext`, but a `context` naming the surface and a
 *   `markersEngagementPanelSyncEntityKey`. This is the panel the viewer opens.
 * - **As an item of the structured description** — carries `title` ("Chapters")
 *   and a `rendererContext` whose tap command opens the panel above.
 *
 * `title` was unconditional before, which made the first shape throw:
 * `Text.fromAttributed` destructures its argument straight away.
 */
export default class MacroMarkersListView extends YTNode {
  static type = 'MacroMarkersListView';

  title?: Text;
  macro_marker_list_entity_key: string;
  /** e.g. `MACRO_MARKERS_LIST_VIEW_MODEL_CONTEXT_DETAIL_VIEW`. */
  context?: string;
  markers_engagement_panel_sync_entity_key?: string;
  renderer_context: RendererContext;

  constructor(data: RawNode) {
    super();

    if (Reflect.has(data, 'title')) {
      this.title = Text.fromAttributed(data.title);
    }

    this.macro_marker_list_entity_key = data.macroMarkerListEntityKey;

    if (Reflect.has(data, 'context')) {
      this.context = data.context;
    }

    if (Reflect.has(data, 'markersEngagementPanelSyncEntityKey')) {
      this.markers_engagement_panel_sync_entity_key = data.markersEngagementPanelSyncEntityKey;
    }

    this.renderer_context = new RendererContext(data.rendererContext);
  }
}
