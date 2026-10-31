import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import * as GcpList from "../../page/infra-integrations/gcp/list/model"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import * as Menu from "../../ui/menu"

// `/lab/gcp-infra`: the Google Cloud list over fixtures, its
// `GcpListState` held here instead of the URL.

export const ListState = Schema.Struct({
	view: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
})
export type ListState = typeof ListState.Type

export const Model = Schema.Struct({
	state: ListState,
	projectMenu: Menu.Model,
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	/** The title row's picker and Reload spin; the fixtures' window never moves. */
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	/** The lab's own pivot: a fresh state on that view (`setState({ view })`). */
	ClickedLabView: { view: Schema.String },
	CompletedLoadIntegrationsPage: {},
	GotListMessage: { message: GcpList.Message },
})
export type Message = typeof Message.Type
