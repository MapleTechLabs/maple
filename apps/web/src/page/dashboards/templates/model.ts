import { DashboardWidgetSchema } from "@maple/domain/http"
import { V2DashboardTemplate, V2DashboardTemplatePreview } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { DashboardsTemplatesSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import { TableSort } from "../kit/tiles"
import { WidgetFailure, WidgetGate } from "../kit/widget-data"

// The template gallery.

export const ReadinessFilter = Schema.Literals(["all", "ready", "needs-setup"])
export type ReadinessFilter = typeof ReadinessFilter.Type

/** The subset of a metric row readiness reads (`MetricLike`). */
export const MetricSeen = Schema.Struct({ metricName: Schema.String, lastSeen: Schema.String })
export type MetricSeen = typeof MetricSeen.Type

export const Model = Schema.Struct({
	search: DashboardsTemplatesSearch,
	nowMs: Schema.NullOr(Schema.Number),
	templates: KeyedSchema(Schema.Array(V2DashboardTemplate), LoadFailure),
	/** `listMetricsResultAtom({ limit: 1000 })`: readiness fails open until it answers. */
	metrics: KeyedSchema(Schema.Array(MetricSeen), LoadFailure),
	/** `ToolbarSearch`'s input, its debounce generation, and the applied query (component state). */
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	query: Schema.String,
	filter: ReadinessFilter,
	/** The selection's preview: armed 250 ms after the template was picked (`SELECTION_DEBOUNCE_MS`). */
	previewGeneration: Schema.Number,
	isPreviewArmed: Schema.Boolean,
	preview: KeyedSchema(V2DashboardTemplatePreview, LoadFailure),
	/** The preview's widgets as stored widgets (the v2 wire widget decoded into the document's). */
	previewWidgets: Schema.Array(DashboardWidgetSchema),
	/** The preview tiles: what each asked for, the fetches, their charts and sorts. */
	gates: Schema.Record(Schema.String, WidgetGate),
	requests: Schema.Record(Schema.String, KeyedSchema(Schema.Unknown, WidgetFailure)),
	charts: Schema.Record(Schema.String, Chart.Model),
	tableSorts: Schema.Record(Schema.String, TableSort),
	previewWidth: Schema.Number,
	/** The parameter form's values, by parameter key. */
	parameters: Schema.Record(Schema.String, Schema.String),
	isCreating: Schema.Boolean,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	/** Below `lg` the detail panel is a right sheet, open while a template is selected. */
	panelSheet: Dialog.Model,
})
export type Model = typeof Model.Type
