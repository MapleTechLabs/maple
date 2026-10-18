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
		/** The request key each widget in the batch was sent under; a newer key drops it. */
		keys: Schema.Record(Schema.String, Schema.String),
		states: Schema.Record(Schema.String, WidgetState),
	},
	ClickedReload: {},
	TickedAutoRefresh: {},
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
