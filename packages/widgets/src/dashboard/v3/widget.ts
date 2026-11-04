import { FunnelVariant, PathsDirection } from "@maple/query-model"
import { Schema, Struct } from "effect"
import { WIDGET_VISUALIZATIONS } from "../../widget-types"
import { SHARE_PRESENTATION_KEYS } from "../redact"
import { makeDashboardWidgetSchemas } from "../shared/widget"
import { WidgetDataSourceV3 } from "./data-source"

/**
 * v3 changes only the data source; `visualization` keeps the closed set v2
 * introduced.
 *
 * Because `makeDashboardWidgetSchemas` derives the display config from the data
 * source, `display.sparkline.dataSource` becomes the v3 union here too — which
 * is exactly why the migration and both API encoders have to recurse into it.
 */
const v3 = makeDashboardWidgetSchemas({
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	dataSource: WidgetDataSourceV3,
})

export const WidgetDisplayConfigV3 = v3.display

/** A data source as a share publishes it: enough to pick a renderer, no query. */
export const SharedDataSource = Schema.Struct({
	kind: Schema.String,
	resultShape: Schema.optionalKey(Schema.String),
	transform: Schema.optionalKey(Schema.Unknown),
})

/** The display `redactForShare` publishes, from the same allowlist, so a tile cannot read a dropped field. */
export const SharedWidgetDisplayV3 = Schema.Struct({
	...Struct.pick(v3.display.fields, SHARE_PRESENTATION_KEYS),
	funnel: Schema.optional(
		Schema.Struct({
			showStepPercent: Schema.optional(Schema.Boolean),
			variant: Schema.optional(FunnelVariant),
		}),
	),
	paths: Schema.optional(Schema.Struct({ direction: Schema.optional(PathsDirection) })),
	sparkline: Schema.optional(
		Schema.Struct({ enabled: Schema.Boolean, dataSource: Schema.optional(SharedDataSource) }),
	),
})
export const DashboardWidgetV3 = v3.widget
