import { OrgId } from "@maple/domain"
import { DashboardDocument, RawSqlDisplayType } from "@maple/domain/http"
import { parseWarehouseDateTime, promqlRowsForDisplay } from "@maple/query-engine"
import { Effect, Option, Record as Rec, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../page/contract"
import { FetchWidget } from "../page/dashboards/widget/command"
import { Message } from "../page/dashboards/widget/message"
import { Model } from "../page/dashboards/widget/model"
import { update as pageUpdate } from "../page/dashboards/widget/page-update"
import { init as pageInit } from "../page/dashboards/widget/update"
import { view as pageView } from "../page/dashboards/widget/view"
import { promqlLabDiscovery, promqlLabResult } from "./promql-widget-fixture"
import {
	DelayPromqlParse,
	FetchPromqlDiscovery,
	ReadPromqlCaret,
} from "../page/dashboards/widget/promql-step"

// The widget editor over a PromQL line chart. Its preview fetches are answered here with
// rows from the real `promqlRowsForDisplay`, so the lab needs no API and no session.

export { Message, Model }

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const NOW = parseWarehouseDateTime("2026-11-15 12:00:00")

const document = Schema.decodeSync(DashboardDocument)({
	id: "dash_lab",
	name: "Prometheus",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "rate",
			visualization: "chart",
			dataSource: {
				kind: "promql",
				query: "sum by (job) (rate(http_server_request_duration_seconds_count[$__rate_interval]))",
				legendFormat: "{{job}}",
				displayType: "line",
			},
			display: { title: "Request rate by service", chartId: "query-builder-line" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-11-01T12:00:00.000Z",
	updatedAt: "2026-11-15T12:00:00.000Z",
	schemaVersion: 3,
})

const PreviewParams = Schema.Struct({
	promql: Schema.String,
	legendFormat: Schema.optional(Schema.String),
	displayType: Schema.optional(RawSqlDisplayType),
})

/** A query whose parentheses do not balance reads as the parser's refusal. */
const isBalanced = (query: string): boolean =>
	Arr.reduce(Str.split(query, ""), 0, (depth, char) =>
		depth < 0 ? depth : char === "(" ? depth + 1 : char === ")" ? depth - 1 : depth,
	) === 0

const LabFetchWidget = Command.define("LabFetchPromqlPreview", {
	args: { key: Schema.String, params: Schema.Record(Schema.String, Schema.Unknown) },
	messages: [Message.CompletedFetchWidget],
	execute: ({ key, params }) =>
		Effect.sync(() => {
			const decoded = Schema.decodeUnknownOption(PreviewParams)(params)
			if (Option.isNone(decoded) || !isBalanced(decoded.value.promql)) {
				return Message.CompletedFetchWidget({
					key,
					result: Result.fail({
						title: null,
						message: "Invalid PromQL: 1:72: parse error: unclosed left parenthesis",
						kind: "decode",
					}),
				})
			}
			const { legendFormat, displayType } = decoded.value
			const rows = promqlRowsForDisplay(promqlLabResult(NOW), {
				...(legendFormat === undefined ? undefined : { legendFormat }),
				...(displayType === undefined ? undefined : { displayType }),
			})
			return Message.CompletedFetchWidget({ key, result: Result.succeed({ data: rows }) })
		}),
})

const FetchArgs = Schema.Struct({ key: Schema.String, params: Schema.Record(Schema.String, Schema.Unknown) })
const DiscoveryArgs = Schema.Struct({ key: Schema.String, label: Schema.optional(Schema.String) })

const discoveryAnswer = (args: typeof DiscoveryArgs.Type) =>
	Message.CompletedFetchPromqlDiscovery({
		key: args.key,
		result: Result.succeed(promqlLabDiscovery(args.label)),
	})

const LabFetchDiscovery = Command.define("LabFetchPromqlDiscovery", {
	args: { key: Schema.String, label: Schema.optional(Schema.String) },
	messages: [Message.CompletedFetchPromqlDiscovery],
	execute: (args) => Effect.succeed(discoveryAnswer(args)),
})

type PageCommand = NonNullable<ReturnType<typeof pageUpdate>["commands"]>[number]

/** Preview fetches answered here; any other request that would reach the API is dropped. */
const offline = (commands: ReadonlyArray<PageCommand> | undefined): ReadonlyArray<PageCommand> =>
	Arr.flatMap(commands ?? [], (command) => {
		if (command.name === FetchWidget.name) {
			return Option.match(Schema.decodeUnknownOption(FetchArgs)(command.args), {
				onNone: () => [],
				onSome: (args) => [LabFetchWidget(args)],
			})
		}
		if (command.name === FetchPromqlDiscovery.name) {
			return Option.match(Schema.decodeUnknownOption(DiscoveryArgs)(command.args), {
				onNone: () => [],
				onSome: (args) => [LabFetchDiscovery(args)],
			})
		}
		return Str.startsWith("Fetch")(command.name) || command.name === "SaveWidget" ? [] : [command]
	})

const BROKEN_QUERY = "sum by (job) (rate(http_server_request_duration_seconds_count[$__rate_interval])"

/** `?state=` opens the editor on a state: `error`, `metrics` (completing a metric) or `values`. */
const STATES = {
	error: BROKEN_QUERY,
	metrics: "sum by (job) (rate(http_server",
	values: 'sum by (job) (rate(http_server_request_duration_seconds_count{job="',
} satisfies Record<string, string>

const labState = (): string | null =>
	typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("state")

/** Typing the state's query, its parse and its caret, with no DOM read or delay. */
const typed = (query: string): ReadonlyArray<Message> => [
	Message.ChangedPromql({ value: query }),
	Message.ElapsedPromqlParseDelay({ seq: 1 }),
	...(labState() === "error" ? [] : [Message.GotPromqlCaret({ caret: query.length, opens: true })]),
]

type Step = Readonly<{ model: Model; commands: ReadonlyArray<PageCommand> }>

/** A seeding step: discovery answered at once, the caret and parse delay left to the messages. */
const seed = (step: Step, message: Message): Step => {
	const next = pageUpdate(step.model, message, context)
	const discovered = Arr.flatMap(next.commands ?? [], (command) =>
		command.name === FetchPromqlDiscovery.name
			? Option.toArray(
					Option.map(Schema.decodeUnknownOption(DiscoveryArgs)(command.args), discoveryAnswer),
				)
			: [],
	)
	const kept = Arr.filter(
		offline(next.commands),
		(command) =>
			command.name !== ReadPromqlCaret.name &&
			command.name !== DelayPromqlParse.name &&
			command.name !== "LabFetchPromqlDiscovery",
	)
	return Arr.reduce(discovered, { model: next.model, commands: [...step.commands, ...kept] }, seed)
}

export const init = () => {
	const opened = pageInit({ dashboardId: "dash_lab", widgetId: "rate", search: {} }, context)
	const query = Arr.findFirst(Rec.toEntries(STATES), ([name]) => name === labState()).pipe(
		Option.map(([, text]) => text),
		Option.getOrUndefined,
	)
	return Arr.reduce(
		[
			Message.CompletedReadClock({ nowMs: NOW }),
			Message.UpdatedDashboard({ orgId: context.orgId, maybeDocument: Option.some(document) }),
			...(query === undefined ? [] : typed(query)),
		],
		{ model: opened.model, commands: offline(opened.commands) },
		seed,
	)
}

export const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, context)
	return { model: next.model, commands: offline(next.commands) }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html => pageView(model, { context }, h)
