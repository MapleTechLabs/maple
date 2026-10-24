import {
	getServiceEndpointDetail,
	getServiceEndpointsTimeseries,
} from "@maple/web-data/warehouse/service-endpoints"
import { Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import * as Chart from "../../../../charts/chart"
import * as Keyed from "../../../../data/keyed"
import { toLoadFailure } from "../../../../data/load-failure"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import type { Resources } from "../../../../platform/resources"
import * as Dialog from "../../../../ui/dialog"
import type { PageContext } from "../../../contract"
import type { Endpoint } from "../model-tabs"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** The peeked endpoint, where it sits in the table and the rows a step lands on. */
export type Peek = Readonly<{
	endpoint: Endpoint
	index: number
	count: number
	neighbors: ReadonlyArray<Endpoint>
}>

/** The peek over the table's visible rows; a span name no row matches means the drawer is closed. */
export const resolvePeek = (rows: ReadonlyArray<Endpoint>, spanName: string | undefined): Peek | null => {
	const index = spanName === undefined ? -1 : rows.findIndex((row) => row.spanName === spanName)
	const endpoint = rows[index]
	if (endpoint === undefined) return null
	const neighbors = [rows[index - 1], rows[index + 1]].filter((row): row is Endpoint => row !== undefined)
	return { endpoint, index, count: rows.length, neighbors }
}

/** What the detail read is scoped by besides the endpoint. */
export type PeekScope = Readonly<{
	context: PageContext
	window: TimeWindow | null
	serviceName: string
	environments: ReadonlyArray<string> | undefined
	bucketSeconds: number
	/** The endpoints the tab's sparkline read already covers; the drawer reads the rest itself. */
	tabSeriesNames: ReadonlyArray<string>
}>

export const DetailInput = Schema.Struct({
	serviceName: Schema.String,
	spanName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
})
export type DetailInput = typeof DetailInput.Type

/** `getServiceEndpointDetail`: the drawer's distribution, body sizes, clients and slowest requests. */
export const FetchEndpointDetail = Command.define("FetchServiceEndpointDetail", {
	args: { spanName: Schema.String, key: Schema.String, input: DetailInput },
	messages: [Message.CompletedFetchDetail],
	execute: ({ spanName, key, input }) =>
		getServiceEndpointDetail({
			data: {
				...input,
				environments: input.environments === undefined ? undefined : [...input.environments],
			},
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDetail({ spanName, key, result })),
		),
})

export const SeriesInput = Schema.Struct({
	...DetailInput.fields,
	bucketSeconds: Schema.Number,
})
export type SeriesInput = typeof SeriesInput.Type

/** `getServiceEndpointsTimeseries` for the one peeked endpoint. */
export const FetchEndpointPeekSeries = Command.define("FetchServiceEndpointPeekSeries", {
	args: { spanName: Schema.String, key: Schema.String, input: SeriesInput },
	messages: [Message.CompletedFetchSeries],
	execute: ({ spanName, key, input }) =>
		getServiceEndpointsTimeseries({
			data: {
				serviceName: input.serviceName,
				startTime: input.startTime,
				endTime: input.endTime,
				environments: input.environments === undefined ? undefined : [...input.environments],
				bucketSeconds: input.bucketSeconds,
				spanNames: [input.spanName],
			},
		}).pipe(
			Effect.map((response) => response.buckets),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSeries({ spanName, key, result })),
		),
})

const detailInputOf = (scope: PeekScope, window: TimeWindow, spanName: string): DetailInput => ({
	serviceName: scope.serviceName,
	spanName,
	startTime: window.startTime,
	endTime: window.endTime,
	environments: scope.environments,
})

/** The detail of each endpoint not already holding (or loading) its key. */
const requestDetails = (
	model: Model,
	scope: PeekScope,
	window: TimeWindow,
	endpoints: ReadonlyArray<Endpoint>,
	mode: Keyed.RequestMode,
): Return =>
	endpoints.reduce<Return>(
		(acc, endpoint) => {
			const input = detailInputOf(scope, window, endpoint.spanName)
			const key = requestKey(scope.context.orgId, "getServiceEndpointDetail", { data: input })
			const slot = acc.model.details[endpoint.spanName] ?? Keyed.idle()
			return Option.match(Keyed.request(slot, key, mode), {
				onNone: () => acc,
				onSome: (next) => ({
					model: { ...acc.model, details: { ...acc.model.details, [endpoint.spanName]: next } },
					commands: [
						...(acc.commands ?? []),
						FetchEndpointDetail({ spanName: endpoint.spanName, key: next.key, input }),
					],
				}),
			})
		},
		{ model },
	)

/** The peeked endpoint's buckets when the tab's sparkline read leaves it out. */
const requestSeries = (
	model: Model,
	scope: PeekScope,
	window: TimeWindow,
	endpoint: Endpoint,
	mode: Keyed.RequestMode,
): Return => {
	if (scope.tabSeriesNames.includes(endpoint.spanName)) return { model }
	const input = { ...detailInputOf(scope, window, endpoint.spanName), bucketSeconds: scope.bucketSeconds }
	const key = requestKey(scope.context.orgId, "getServiceEndpointsTimeseries", { data: input })
	const slot = model.series[endpoint.spanName] ?? Keyed.idle()
	return Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({
			model: { ...model, series: { ...model.series, [endpoint.spanName]: next } },
			commands: [FetchEndpointPeekSeries({ spanName: endpoint.spanName, key: next.key, input })],
		}),
	})
}

const request = (
	model: Model,
	scope: PeekScope,
	window: TimeWindow,
	peek: Peek,
	mode: Keyed.RequestMode,
): Return => {
	const details = requestDetails(model, scope, window, [peek.endpoint, ...peek.neighbors], mode)
	const series = requestSeries(details.model, scope, window, peek.endpoint, mode)
	return { model: series.model, commands: [...(details.commands ?? []), ...(series.commands ?? [])] }
}

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/**
 * Follows the table: opens on a peeked row (warming it and its neighbours), closes when the span
 * name no longer matches a row. The URL already says so, so the dialog's own Opened is dropped.
 */
export const sync = (model: Model, scope: PeekScope, peek: Peek | null, mode: Keyed.RequestMode): Return => {
	if (peek === null) return model.dialog.isOpen ? liftDialog(model, Dialog.close(model.dialog)) : { model }
	const opened = model.dialog.isOpen ? { model } : liftDialog(model, Dialog.open(model.dialog))
	if (scope.window === null) return opened
	const requested = request(opened.model, scope, scope.window, peek, mode)
	return { model: requested.model, commands: [...(opened.commands ?? []), ...(requested.commands ?? [])] }
}

export const update = (model: Model, message: Message, scope: PeekScope, peek: Peek | null): Return =>
	Message.match<Return>(message, {
		CompletedFetchDetail: ({ spanName, key, result }) => {
			const slot = model.details[spanName]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							details: { ...model.details, [spanName]: Keyed.accept(slot, key, result) },
						},
					}
		},
		CompletedFetchSeries: ({ spanName, key, result }) => {
			const slot = model.series[spanName]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							series: { ...model.series, [spanName]: Keyed.accept(slot, key, result) },
						},
					}
		},
		ClickedStep: ({ step }) => ({ model, outMessage: OutMessage.RequestedStep({ step }) }),
		PressedStepKey: ({ step }) => ({ model, outMessage: OutMessage.RequestedStep({ step }) }),
		ClickedRetryDetail: () =>
			peek === null || scope.window === null
				? { model }
				: requestDetails(model, scope, scope.window, [peek.endpoint], "Refresh"),
		GotChartMessage: ({ chartId, message: inner }) => {
			const chart = model.charts[chartId] ?? Chart.init()
			const next = Chart.update(chart, inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotChartMessage({ chartId, message: child }),
				),
			}
		},
		GotDialogMessage: ({ message: inner }) => {
			const result = Dialog.update(model.dialog, inner)
			const lifted = liftDialog(model, result)
			return result.outMessage?._tag === "Closed"
				? { ...lifted, outMessage: OutMessage.Closed() }
				: lifted
		},
	})
