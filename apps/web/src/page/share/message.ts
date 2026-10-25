import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ThemeColors } from "../../charts/theme-colors"
import * as Menu from "../../ui/menu"
import { Resolve, WidgetState } from "./model"

export const Message = defineMessageUnion({
	CompletedResolveClock: { nowMs: Schema.Number },
	CompletedResolveShare: { token: Schema.String, resolve: Resolve },
	/** A tile measured itself: its `maxDataPoints` (`ShareWidgetOptionsReporter`). */
	MeasuredWidget: { widgetId: Schema.String, maxDataPoints: Schema.Number },
	MeasuredGrid: { width: Schema.Number },
	/** The frame the tiles reported in has passed: send what changed, in batches of four. */
	CompletedFlushFrame: {},
	CompletedFetchBatch: {
		/** The `sentBatchId` the batch went out under; only the latest one advances the queue. */
		batchId: Schema.Number,
		/** The request key each widget in the batch was sent under; a newer key drops it. */
		keys: Schema.Record(Schema.String, Schema.String),
		states: Schema.Record(Schema.String, WidgetState),
		/** The variables the server resolved for this batch, when it sent them. */
		variables: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	},
	CompletedReadFrame: { isFramed: Schema.Boolean },
	AppliedShareAppearance: {},
	ClickedSectionChevron: { sectionId: Schema.String, collapsed: Schema.Boolean },
	ClickedSectionTab: { sectionId: Schema.String, tabId: Schema.String },
	ClickedReload: {},
	TickedAutoRefresh: {},
	/** The clock a Reload or an auto-refresh tick resolves its relative window at. */
	CompletedResolveReloadClock: { nowMs: Schema.Number },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { widgetId: Schema.String, message: Chart.Message },
	ClickedSortColumn: { widgetId: Schema.String, field: Schema.String, isText: Schema.Boolean },
	GotRefreshMenuMessage: { message: Menu.Message },
	ClickedSignIn: {},
	StartedSignInRedirect: {},
})
export type Message = typeof Message.Type
