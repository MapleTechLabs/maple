import { Option, Record, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../charts/chart"
import { ChartRuntime, LoadChartRuntime } from "../charts/chart-runtime"
import { ThemeColors } from "../charts/theme-colors"
import { ToolPercentile } from "../page/agent-sessions/tools-kit/model"
import { facetValue, initFacetSelect } from "../page/agent-sessions/tools-kit/toolbar"
import * as TimeRangePicker from "../page/kit/time-range-picker"
import type { McpFilters, McpWindow } from "../page/mcp/view-kit"
import { McpClientIdentity, McpMetric } from "../page/mcp/view-server"
import { McpCallList } from "../page/mcp/view-tool"
import type { Resources } from "../platform/resources"
import * as Select from "../ui/select"
import * as ToggleGroup from "../ui/toggle-group"
import { MCP_NOW } from "./mcp-fixture"

// `/lab/mcp`'s Model, Messages and update, apart from its view so tests can drive them.

export const VIEWS = ["list", "server", "tool", "service", "empty", "loading", "error", "quiet"] as const
export type View = (typeof VIEWS)[number]
export const VIEW_LABEL = {
	list: "/mcp",
	server: "/mcp/maple-ai",
	tool: "tool: run_sql",
	service: "service MCP tab",
	empty: "empty",
	loading: "loading",
	error: "error",
	quiet: "quiet window",
} satisfies { readonly [K in View]: string }
export const TIME_ZONE = "Europe/Berlin"
export const PRESET = "6h"
export const WINDOW: McpWindow = {
	startMs: MCP_NOW - 6 * 3_600_000,
	label: "Last 6 hours",
	bucketLabel: "15m",
}

export const Model = Schema.Struct({
	view: Schema.Literals(VIEWS),
	metric: McpMetric,
	percentileToggle: ToggleGroup.Model,
	clientToggle: ToggleGroup.Model,
	callsToggle: ToggleGroup.Model,
	clientSelect: Select.Model,
	kindSelect: Select.Model,
	client: Schema.UndefinedOr(Schema.String),
	kind: Schema.UndefinedOr(Schema.String),
	isFailingOnly: Schema.Boolean,
	searchInput: Schema.String,
	timePicker: TimeRangePicker.Model,
	charts: Schema.Record(Schema.String, Chart.Model),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
})
export type Model = typeof Model.Type

const Facet = Schema.Literals(["client", "kind"])

export const Message = defineMessageUnion({
	ClickedView: { view: Schema.Literals(VIEWS) },
	ClickedMetric: { metric: McpMetric },
	GotPercentileMessage: { message: ToggleGroup.Message },
	GotClientToggleMessage: { message: ToggleGroup.Message },
	GotCallsToggleMessage: { message: ToggleGroup.Message },
	GotSelectMessage: { facet: Facet, message: Select.Message },
	ToggledFailingOnly: {},
	ChangedSearchInput: { value: Schema.String },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	Ignored: {},
})
export type Message = typeof Message.Type
type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

export const Flags = Schema.Struct({ view: Schema.Literals(VIEWS) })
export type Flags = typeof Flags.Type
export const decodeView = Schema.decodeUnknownOption(Schema.Literals(VIEWS))
export const decodePercentile = Schema.decodeUnknownOption(ToolPercentile)
export const decodeIdentity = Schema.decodeUnknownOption(McpClientIdentity)
export const decodeCallList = Schema.decodeUnknownOption(McpCallList)

/** A toggle group's one pressed value, decoded, or the fallback. */
export const pressed = <A>(
	model: ToggleGroup.Model,
	decode: (value: string | undefined) => Option.Option<A>,
	fallback: A,
): A => Option.getOrElse(decode(model.values[0]), () => fallback)

export const init = (flags: Flags): Return => ({
	model: {
		view: flags.view,
		metric: "calls",
		percentileToggle: ToggleGroup.init({ label: "Percentile", values: ["p90"] }),
		clientToggle: ToggleGroup.init({ label: "Client identity", values: ["ua"] }),
		callsToggle: ToggleGroup.init({ label: "Calls", values: ["slowest"] }),
		clientSelect: initFacetSelect("mcp-client-select", undefined),
		kindSelect: initFacetSelect("mcp-kind-select", undefined),
		client: undefined,
		kind: undefined,
		isFailingOnly: false,
		searchInput: "",
		timePicker: TimeRangePicker.init("mcp-time-range-picker"),
		charts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/** A toggle group keeps one value pressed: a press on the pressed item leaves it as it was. */
const toggleStep = (
	current: ToggleGroup.Model,
	message: ToggleGroup.Message,
	wrap: (message: ToggleGroup.Message) => Message,
	write: (next: ToggleGroup.Model) => Model,
): Return => {
	const next = ToggleGroup.update(current, message)
	const kept = next.model.values.length === 0 ? { ...next.model, values: current.values } : next.model
	return { model: write(kept), commands: Command.mapMessages(next.commands ?? [], wrap) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedView: ({ view }) => ({ model: { ...model, view } }),
		ClickedMetric: ({ metric }) => ({ model: { ...model, metric } }),
		GotPercentileMessage: ({ message: inner }) =>
			toggleStep(
				model.percentileToggle,
				inner,
				(m) => Message.GotPercentileMessage({ message: m }),
				// Arrow keys and focus reach here too; only a new percentile switches the chart.
				(next) => ({
					...model,
					percentileToggle: next,
					metric: next.values[0] === model.percentileToggle.values[0] ? model.metric : "duration",
				}),
			),
		GotClientToggleMessage: ({ message: inner }) =>
			toggleStep(
				model.clientToggle,
				inner,
				(m) => Message.GotClientToggleMessage({ message: m }),
				(next) => ({
					...model,
					clientToggle: next,
				}),
			),
		GotCallsToggleMessage: ({ message: inner }) =>
			toggleStep(
				model.callsToggle,
				inner,
				(m) => Message.GotCallsToggleMessage({ message: m }),
				(next) => ({
					...model,
					callsToggle: next,
				}),
			),
		GotSelectMessage: ({ facet, message: inner }) => {
			const current = facet === "client" ? model.clientSelect : model.kindSelect
			const next = Select.update(current, inner)
			const value =
				next.outMessage === undefined
					? facet === "client"
						? model.client
						: model.kind
					: facetValue(next.outMessage.value)
			return {
				model:
					facet === "client"
						? { ...model, clientSelect: next.model, client: value }
						: { ...model, kindSelect: next.model, kind: value },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotSelectMessage({ facet, message: m }),
				),
			}
		},
		ToggledFailingOnly: () => ({ model: { ...model, isFailingOnly: !model.isFailingOnly } }),
		ChangedSearchInput: ({ value }) => ({ model: { ...model, searchInput: value } }),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			return {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTimePickerMessage({ message: m }),
				),
			}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: Record.set(model.charts, chartId, next.model) },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ chartId, message: m }),
				),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		Ignored: () => ({ model }),
	})

export const filtersOf = (model: Model): McpFilters => ({
	search: model.searchInput,
	client: model.client,
	kind: model.kind,
	isFailingOnly: model.isFailingOnly,
})
