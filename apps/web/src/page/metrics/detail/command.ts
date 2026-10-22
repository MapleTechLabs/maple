import { MetricsQueryDraftSchema, QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import {
	getMetricAttributeKeys,
	getMetricAttributeValues,
	listMetrics,
} from "@maple/web-data/warehouse/metrics"
import { getQueryBuilderBreakdown } from "@maple/web-data/warehouse/query-builder-breakdown"
import { getQueryBuilderTimeseries } from "@maple/web-data/warehouse/query-builder-timeseries"
import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import { Message, RequestMode } from "./message"
import { AutocompleteLookup } from "./model"
import { autocompleteLookup } from "../../kit/autocomplete-lookups"
import { caretEvents, placeCaret, WHERE_TEXTAREA_ID } from "./where-editor"
import { listboxEvents } from "../../kit/where-autocomplete"

export const ResolveWindow = Command.define("ResolveMetricWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result)

export const FetchCatalog = Command.define("FetchMetricCatalog", {
	args: { key: Schema.String, metricName: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchCatalog],
	execute: ({ key, metricName, window }) =>
		settle(
			Effect.map(
				listMetrics({
					data: {
						search: metricName,
						startTime: window.startTime,
						endTime: window.endTime,
						limit: 1000,
					},
				}),
				(response) => response.data,
			),
		).pipe(Effect.map((result) => Message.CompletedFetchCatalog({ key, result }))),
})

export const FetchAutocomplete = Command.define("FetchMetricAutocomplete", {
	args: { key: Schema.String, lookup: AutocompleteLookup, window: TimeWindow },
	messages: [Message.CompletedFetchAutocomplete],
	execute: (args) =>
		settle(autocompleteLookup(args.lookup, args.window)).pipe(
			Effect.map((result) =>
				Message.CompletedFetchAutocomplete({ key: args.key, lookup: args.lookup, result }),
			),
		),
})

export const AttributeKeysInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	metricName: Schema.String,
	metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
})
export type AttributeKeysInput = typeof AttributeKeysInput.Type

export const FetchAttributeKeys = Command.define("FetchMetricAttributeKeys", {
	args: { key: Schema.String, input: AttributeKeysInput },
	messages: [Message.CompletedFetchAttributeKeys],
	execute: ({ key, input }) =>
		settle(Effect.map(getMetricAttributeKeys({ data: input }), (response) => response.data)).pipe(
			Effect.map((result) => Message.CompletedFetchAttributeKeys({ key, result })),
		),
})

export const DraftInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	query: MetricsQueryDraftSchema,
})
export type DraftInput = typeof DraftInput.Type

export const FetchTimeseries = Command.define("FetchMetricTimeseries", {
	args: { key: Schema.String, input: DraftInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		settle(
			Effect.map(
				getQueryBuilderTimeseries({
					data: {
						startTime: input.startTime,
						endTime: input.endTime,
						queries: [{ ...input.query }],
					},
				}),
				(response) => response.data,
			),
		).pipe(Effect.map((result) => Message.CompletedFetchTimeseries({ key, result }))),
})

export const FetchBreakdown = Command.define("FetchMetricBreakdown", {
	args: { key: Schema.String, input: DraftInput },
	messages: [Message.CompletedFetchBreakdown],
	execute: ({ key, input }) =>
		settle(
			Effect.map(
				getQueryBuilderBreakdown({
					data: {
						startTime: input.startTime,
						endTime: input.endTime,
						queries: [{ ...input.query }],
					},
				}),
				// `BreakdownBars`: names stringified, values numbers, blank names dropped.
				(response) =>
					response.data
						.map((row) => ({
							name: String(row.name ?? ""),
							value: typeof row.value === "number" ? row.value : Number(row.value ?? 0),
						}))
						.filter((row) => row.name.length > 0),
			),
		).pipe(Effect.map((result) => Message.CompletedFetchBreakdown({ key, result }))),
})

/** `encodeAlertChartToSearchParam` (lib/alerts/widget-chart-param.ts imports `@/` modules) over `toBase64Url`. */
const MAX_ENCODED_LENGTH = 12_000
const toBase64Url = (input: string): string =>
	btoa(String.fromCharCode(...new TextEncoder().encode(input)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")

/**
 * `MetricGraduationActions`' Create alert: the current query as a chart widget snapshot in the
 * `chart` param. Fresh ids, so it runs here rather than in `update`.
 */
export const BuildAlertLink = Command.define("BuildMetricAlertLink", {
	args: { query: MetricsQueryDraftSchema, title: Schema.String },
	messages: [Message.BuiltAlertLink],
	execute: ({ query, title }) =>
		Effect.sync(() => {
			const chart = toBase64Url(
				JSON.stringify({
					dashboardId: "metrics-explorer",
					widget: {
						id: crypto.randomUUID(),
						visualization: "chart",
						dataSource: {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ ...query, id: crypto.randomUUID() }],
						},
						display: { title },
					},
				}),
			)
			const search = chart.length > MAX_ENCODED_LENGTH ? {} : { chart }
			return Message.BuiltAlertLink({ url: hrefOf(AppRoute.AlertsCreate({ search })) })
		}),
})

/** `MetricQueryControls`' where commit: 400 ms after the last keystroke. */
export const DebounceWhere = Command.define("DebounceMetricWhere", {
	args: { generation: Schema.Number },
	messages: [Message.CompletedWhereDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(400)), Message.CompletedWhereDebounce({ generation })),
})

/** `CopyButton value={() => window.location.href}`: read when clicked. */
export const ReadLocation = Command.define("ReadMetricLocation", {
	messages: [Message.ReadLocationHref],
	execute: Effect.sync(() => Message.ReadLocationHref({ href: window.location.href })),
})

export const CompleteReloadSpin = Command.define("CompleteMetricReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** The where textarea's caret, focus and blur, read off the native events. */
export const MountWhereCaret = Mount.defineStream("MountMetricWhereCaret", {
	messages: [Message.GotCaretMessage],
	execute: ({ element }) =>
		Stream.map(caretEvents(element), (message) => Message.GotCaretMessage({ message })),
})

/** The open list: the textarea keeps focus while a row is pressed, and the list follows it. */
export const MountKeepWhereFocus = Mount.defineStream("MountMetricKeepWhereFocus", {
	messages: [Message.GotCaretMessage],
	execute: ({ element }) =>
		Stream.map(listboxEvents(element, WHERE_TEXTAREA_ID), (message) =>
			Message.GotCaretMessage({ message }),
		),
})

export const PlaceWhereCaret = Command.define("PlaceMetricWhereCaret", {
	args: { value: Schema.String, cursor: Schema.Number },
	messages: [Message.CompletedPlaceWhereCaret],
	execute: ({ value, cursor }) =>
		Effect.as(placeCaret(WHERE_TEXTAREA_ID, value, cursor), Message.CompletedPlaceWhereCaret()),
})

export const AttributeValuesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	attributeKey: Schema.String,
	metricName: Schema.String,
	metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
})

/** `getMetricAttributeValuesResultAtom`: the values offered after `attr.<key> =`. */
export const FetchAttributeValues = Command.define("FetchMetricAttributeValues", {
	args: { key: Schema.String, input: AttributeValuesInput },
	messages: [Message.CompletedFetchAttributeValues],
	execute: ({ key, input }) =>
		settle(
			Effect.map(getMetricAttributeValues({ data: input }), (response) =>
				response.data.map((row) => row.attributeValue),
			),
		).pipe(Effect.map((result) => Message.CompletedFetchAttributeValues({ key, result }))),
})
