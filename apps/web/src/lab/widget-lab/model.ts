import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import * as Shell from "../../shell"
import * as CopyButton from "../../ui/copy-button"
import * as Menu from "../../ui/menu"
import * as Popover from "../../ui/popover"
import * as Toast from "../../ui/toast"
import * as ToggleGroup from "../../ui/toggle-group"
import { TableSort } from "../../page/dashboards/kit/tiles"

// `/lab/widgets`: every dashboard tile over fixtures.

export const Model = Schema.Struct({
	shell: Shell.Model,
	toasts: Toast.Model,
	/** The View / Edit toggle: the tiles' `mode`. */
	mode: ToggleGroup.Model,
	timeZone: Schema.String,
	nowMs: Schema.NullOr(Schema.Number),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	/** One chart slot per cell (and per sparkline), by cell id. */
	charts: Schema.Record(Schema.String, Chart.Model),
	copies: Schema.Record(Schema.String, CopyButton.Model),
	/** The failed tiles' "Details" popovers, by cell id. */
	details: Schema.Record(Schema.String, Popover.Model),
	/** The one open tile menu (edit mode), as the dashboard keeps it. */
	menuId: Schema.NullOr(Schema.String),
	menu: Menu.Model,
	tableSorts: Schema.Record(Schema.String, TableSort),
	/** The session org: the dashboards collection syncs for it. */
	orgId: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotShellMessage: { message: Shell.Message },
	GotToastMessage: { message: Toast.Message },
	GotModeMessage: { message: ToggleGroup.Message },
	CompletedReadClock: { nowMs: Schema.Number },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotChartMessage: { slot: Schema.String, message: Chart.Message },
	GotCopyMessage: { slot: Schema.String, message: CopyButton.Message },
	GotDetailsMessage: { slot: Schema.String, message: Popover.Message },
	GotMenuMessage: { slot: Schema.String, message: Menu.Message },
	ClickedSortColumn: { slot: Schema.String, field: Schema.String, isText: Schema.Boolean },
	/** A widget action (`labActions`): the lab has nothing to do. */
	ClickedWidgetAction: { action: Schema.String },
	UpdatedDashboards: { orgId: Schema.String },
})
export type Message = typeof Message.Type
