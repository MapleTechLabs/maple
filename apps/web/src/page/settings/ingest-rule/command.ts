import { IngestRuleId } from "@maple/domain"
import { V2IngestRuleCreateParams } from "@maple/domain/http/v2"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { executeQueryEngine } from "@maple/web-data/warehouse/effect-utils"
import { getLogAttributeKeys, listLogs } from "@maple/web-data/warehouse/logs"
import {
	getResourceAttributeKeys,
	getSpanAttributeKeys,
	getTracesFacets,
} from "@maple/web-data/warehouse/traces"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { currentWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { readIsAdmin } from "../../alerts/shared/commands"
import { KeyScope, Message } from "./message"
import { PreviewSignal, type Samples, type SpanSample } from "./preview"

export const SAMPLE_LIMIT = 100

export const FetchRule = Command.define("FetchIngestRule", {
	args: { id: IngestRuleId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.ingestRules.retrieve({ params: { id } })).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExisting({ result })),
		),
})

export const FetchSession = Command.define("FetchIngestRuleSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

/** Key suggestions for attribute conditions; empty on failure, the input still takes any key. */
export const FetchKeys = Command.define("FetchIngestRuleKeys", {
	args: { scope: KeyScope },
	messages: [Message.CompletedFetchKeys],
	execute: ({ scope }) =>
		(scope === "span"
			? getSpanAttributeKeys({ data: {} })
			: scope === "log"
				? getLogAttributeKeys({ data: {} })
				: getResourceAttributeKeys({ data: {} })
		).pipe(
			Effect.map((response) => response.data.map((row) => row.attributeKey)),
			Effect.orElseSucceed((): ReadonlyArray<string> => []),
			Effect.map((keys) => Message.CompletedFetchKeys({ scope, keys })),
		),
})

export const FetchServices = Command.define("FetchIngestRuleServices", {
	messages: [Message.CompletedFetchServices],
	execute: currentWindow({ preset: "24h", snap: true }).pipe(
		Effect.flatMap((window) => getTracesFacets({ data: window })),
		Effect.map((response) => response.data.services.map((row) => row.name)),
		Effect.orElseSucceed((): ReadonlyArray<string> => []),
		Effect.map((services) => Message.CompletedFetchServices({ services })),
	),
})

/** A per-span list row; the attribute maps are absent when the engine projects columns. */
const SpanWireRow = Schema.Struct({
	serviceName: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.optionalKey(Schema.String),
	statusCode: Schema.String,
	traceId: Schema.String,
	spanAttributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	resourceAttributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
const decodeSpanRows = Schema.decodeUnknownEffect(Schema.Array(SpanWireRow))
const toSpanSample = (row: typeof SpanWireRow.Type): SpanSample => ({
	...row,
	spanKind: row.spanKind ?? "",
	spanAttributes: row.spanAttributes ?? {},
	resourceAttributes: row.resourceAttributes ?? {},
})
const decodeRequest = Schema.decodeUnknownEffect(QueryEngineExecuteRequest)

/** The logs explorer's list: the newest rows of the last hour. */
const recentLogs = (window: { startTime: string; endTime: string }, service: string) =>
	listLogs({
		data:
			service === "" ? { ...window, limit: SAMPLE_LIMIT } : { ...window, limit: SAMPLE_LIMIT, service },
	}).pipe(
		Effect.map((response): Samples => ({
			_tag: "logs",
			rows: response.data.map((row) => ({
				serviceName: row.serviceName,
				body: row.body,
				severityNumber: row.severityNumber,
				severityText: row.severityText,
				traceId: row.traceId ?? "",
				logAttributes: row.logAttributes,
				resourceAttributes: row.resourceAttributes,
			})),
		})),
	)

/** The traces explorer's per-span list without a column projection, so both attribute maps come back. */
const recentSpans = (window: { startTime: string; endTime: string }, service: string) =>
	decodeRequest({
		...window,
		query: {
			kind: "list",
			source: "traces",
			groupByTrace: false,
			limit: SAMPLE_LIMIT,
			filters:
				service === "" ? { rootSpansOnly: false } : { rootSpansOnly: false, serviceNames: [service] },
		},
	}).pipe(
		Effect.flatMap((request) => executeQueryEngine("ingestRules.previewSpans", request)),
		Effect.flatMap((response) =>
			response.result.kind === "list" ? decodeSpanRows(response.result.data) : Effect.succeed([]),
		),
		Effect.map((rows): Samples => ({ _tag: "traces", rows: rows.map(toSpanSample) })),
	)

export const FetchSamples = Command.define("FetchIngestRuleSamples", {
	args: { key: Schema.String, signal: PreviewSignal, service: Schema.String },
	messages: [Message.CompletedFetchSamples],
	execute: ({ key, signal, service }) =>
		Effect.gen(function* () {
			const window = yield* currentWindow({ preset: "1h", snap: true })
			return signal === "logs"
				? yield* recentLogs(window, service)
				: yield* recentSpans(window, service)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSamples({ key, result })),
		),
})

export const SaveRule = Command.define("SaveIngestRule", {
	args: { editingId: Schema.NullOr(IngestRuleId), payload: V2IngestRuleCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			editingId === null
				? client.ingestRules.create({ payload })
				: client.ingestRules.update({ params: { id: editingId }, payload }),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})
