import { Message as HubMessage, RuleBucket } from "../../page/alerts/hub/message"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import * as AlertsHub from "../../page/alerts/hub/model"
import * as Shell from "../../shell"

// `/lab/alerts`: the hub's tabs and the incident page over one
// fixture org (`buildAlertsLabFixture`), inside the real shell.

export const Model = Schema.Struct({
	/** `useState(() => Date.now())`: the fixture is a function of the clock read at boot. */
	nowMs: Schema.Number,
	timeZone: Schema.String,
	/** The hub's Model, for the views that read its menus and the rules search. */
	hub: AlertsHub.Model,
	/** The Rules section's status chip (`useState<RuleBucket>`). */
	status: Schema.NullOr(RuleBucket),
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	shell: Shell.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotHubMessage: { message: HubMessage },
	GotChartMessage: { message: Chart.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotShellMessage: { message: Shell.Message },
})
export type Message = typeof Message.Type
