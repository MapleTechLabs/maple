import { formatWarehouseDateTime, formatWarehouseDateTimeMs } from "@maple/query-engine"
import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { computeTraceTimeWindow } from "@maple/web-data/lib/trace-time-window"
import { TraceId } from "@maple/domain"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { LogRecord } from "@maple/views/ui/logs/log-row-view"
import { LogSource, LogsRequest } from "../log-source"
import { Message, type Model } from "./model"

// The reads behind `LogTraceTimeline` and `LogContextPanel`, sent while their panel is on show,
// through `LogSource`.

const CONTEXT_SIZE = 25
const CONTEXT_WINDOW_MS = 60 * 60 * 1000
export const TRACE_LOG_LIMIT = 200
const INSTANCE_KEYS = ["k8s.pod.name", "service.instance.id"] as const
const WAREHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/

type Cmd = Command.Command<Message, never, LogSource>

const InstanceAttribute = Schema.Struct({ key: Schema.String, value: Schema.String })
export type InstanceAttribute = typeof InstanceAttribute.Type

const Side = Schema.Literals(["before", "after"])
type Side = typeof Side.Type

/** `instanceAttribute`: the most specific resource attribute that names one running instance. */
export const instanceAttribute = (log: LogRecord): InstanceAttribute | undefined => {
	return Option.getOrUndefined(
		Option.map(
			Arr.findFirst(INSTANCE_KEYS, (candidate) => (log.resourceAttributes[candidate] ?? "") !== ""),
			(key) => ({ key, value: log.resourceAttributes[key] ?? "" }),
		),
	)
}

/** `contextKey`: the record hash when the row has one, else timestamp, span and body. */
export const contextKey = (log: LogRecord): string =>
	log.recordIdentity ?? `${log.exactTimestamp}|${log.spanId ?? ""}|${log.body}`

export const timestampMs = (timestamp: string): number =>
	new Date(Str.includes("T")(timestamp) ? timestamp : `${Str.replace(" ", "T")(timestamp)}Z`).getTime()

/** The scope in effect: the instance when the log names one and it is chosen. */
export const scopedInstance = (model: Model, log: LogRecord): InstanceAttribute | undefined => {
	const instance = instanceAttribute(log)
	return instance !== undefined && model.contextScope.values[0] === "instance" ? instance : undefined
}

/** `applyGlobalNamespace(data, "top")`: the pin is the only namespace filter. */
const pinned = (pinnedNamespace: string | null): Pick<LogsRequest, "namespaces"> =>
	pinnedNamespace === null ? {} : { namespaces: [pinnedNamespace] }

/** `contextInputs`: 25 logs each side within an hour; both sides include this instant. */
export const contextInput = (
	log: LogRecord,
	instance: InstanceAttribute | undefined,
	side: Side,
	pinnedNamespace: string | null,
): LogsRequest | undefined => {
	const ms = timestampMs(log.timestamp)
	if (Number.isNaN(ms)) return undefined
	const at = WAREHOUSE_DATETIME.test(log.exactTimestamp)
		? log.exactTimestamp
		: formatWarehouseDateTimeMs(ms)
	const service: LogsRequest = {
		services: [log.serviceName],
		limit: CONTEXT_SIZE + 1,
		...pinned(pinnedNamespace),
	}
	const shared: LogsRequest =
		instance === undefined
			? service
			: {
					...service,
					resourceAttributeFilters: [{ key: instance.key, value: instance.value, mode: "equals" }],
				}
	return side === "before"
		? {
				...shared,
				startTime: snapTimestamp(formatWarehouseDateTime(ms - CONTEXT_WINDOW_MS)),
				endTime: at,
			}
		: {
				...shared,
				startTime: at,
				endTime: snapTimestamp(formatWarehouseDateTime(ms + CONTEXT_WINDOW_MS)),
				order: "asc" as const,
			}
}

/** `mergeLogContext`: the selected log between its neighbours, oldest first, deduped by identity. */
export const mergeLogContext = (
	selected: LogRecord,
	beforeDesc: ReadonlyArray<LogRecord>,
	afterAsc: ReadonlyArray<LogRecord>,
): ReadonlyArray<LogRecord> => {
	const seen = new Set([contextKey(selected)])
	const unique = (rows: ReadonlyArray<LogRecord>) =>
		Arr.filter(rows, (row) => {
			const key = contextKey(row)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	const before = Arr.reverse(unique(beforeDesc).slice(0, CONTEXT_SIZE))
	const after = unique(afterAsc).slice(0, CONTEXT_SIZE)
	return [...before, selected, ...after]
}

/** `listLogsResultAtom({ data: before | after })`. */
export const FetchContext = Command.define("FetchLogContext", {
	args: { key: Schema.String, side: Side, request: LogsRequest },
	messages: [Message.CompletedFetchContext],
	execute: ({ key, side, request }) =>
		LogSource.use((source) => source.listLogs(request)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchContext({ key, side, result })),
		),
})

/** `listLogsResultAtom({ traceId, limit: 200, ...traceWindow(timestamp) })`. */
export const FetchTraceLogs = Command.define("FetchLogTraceLogs", {
	args: {
		key: Schema.String,
		traceId: TraceId,
		timestamp: Schema.String,
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedFetchTraceLogs],
	execute: ({ key, traceId, timestamp, pinnedNamespace }) =>
		LogSource.use((source) => source.listLogs(traceLogsInput(traceId, timestamp, pinnedNamespace))).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraceLogs({ key, result })),
		),
})

/** `getSpanHierarchyResultAtom({ traceId, timestamp })`: span names and the trace's start. */
export const FetchTraceSpans = Command.define("FetchLogTraceSpans", {
	args: { key: Schema.String, traceId: TraceId, timestamp: Schema.String },
	messages: [Message.CompletedFetchTraceSpans],
	execute: ({ key, traceId, timestamp }) =>
		LogSource.use((source) => source.traceSpans({ traceId, timestamp })).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraceSpans({ key, result })),
		),
})

/** The trace's window as the request sends it: whole-second bounds snapped to 15 s. */
export const traceWindow = (timestamp: string) => {
	const window = computeTraceTimeWindow(timestamp)
	return window === undefined
		? undefined
		: { startTime: snapTimestamp(window.startTime), endTime: snapTimestamp(window.endTime) }
}

export const traceLogsInput = (
	traceId: TraceId,
	timestamp: string,
	pinnedNamespace: string | null,
): LogsRequest => ({
	traceId,
	limit: TRACE_LOG_LIMIT,
	...traceWindow(timestamp),
	...pinned(pinnedNamespace),
})

type Step = Readonly<{ model: Model; commands: ReadonlyArray<Cmd> }>

const slotStep = <A, E>(
	step: Step,
	slot: (model: Model) => Keyed.Keyed<A, E>,
	key: string,
	write: (model: Model, next: Keyed.Keyed<A, E>) => Model,
	fetch: Cmd,
): Step =>
	Option.match(Keyed.request(slot(step.model), key, "Load"), {
		onNone: () => step,
		onSome: (next) => ({ model: write(step.model, next), commands: [...step.commands, fetch] }),
	})

const isShowing = (model: Model, tab: string) =>
	model.isPage || (model.dialog.isOpen && model.tabs.selected === tab)

export const contextKeyOf = (model: Model, log: LogRecord, side: Side): string | undefined => {
	const input = contextInput(log, scopedInstance(model, log), side, model.pinnedNamespace)
	return input === undefined ? undefined : requestKey(model.orgId, "listLogs", { data: input })
}

/** A log without a readable timestamp has no context to read. */
const requestContext = (step: Step, log: LogRecord): Step => {
	if (!isShowing(step.model, "context")) return step
	const instance = scopedInstance(step.model, log)
	return Arr.reduce(["before", "after"] as const, step, (acc, side) => {
		const request = contextInput(log, instance, side, acc.model.pinnedNamespace)
		if (request === undefined) return acc
		const key = requestKey(acc.model.orgId, "listLogs", { data: request })
		const fetch = FetchContext({ key, side, request })
		return side === "before"
			? slotStep(
					acc,
					(m) => m.contextBefore,
					key,
					(m, contextBefore) => ({ ...m, contextBefore }),
					fetch,
				)
			: slotStep(
					acc,
					(m) => m.contextAfter,
					key,
					(m, contextAfter) => ({ ...m, contextAfter }),
					fetch,
				)
	})
}

const requestTrace = (step: Step, log: LogRecord): Step => {
	const traceId = log.traceId
	if (traceId === undefined || traceId === "" || !isShowing(step.model, "trace")) return step
	const { pinnedNamespace } = step.model
	const logsKey = requestKey(step.model.orgId, "listLogs", {
		data: traceLogsInput(traceId, log.timestamp, pinnedNamespace),
	})
	const spansKey = requestKey(step.model.orgId, "getSpanHierarchy", {
		data: { traceId, timestamp: log.timestamp },
	})
	const withLogs = slotStep(
		step,
		(m) => m.traceLogs,
		logsKey,
		(m, traceLogs) => ({ ...m, traceLogs }),
		FetchTraceLogs({ key: logsKey, traceId, timestamp: log.timestamp, pinnedNamespace }),
	)
	return slotStep(
		withLogs,
		(m) => m.traceSpans,
		spansKey,
		(m, traceSpans) => ({ ...m, traceSpans }),
		FetchTraceSpans({ key: spansKey, traceId, timestamp: log.timestamp }),
	)
}

/** The panels on show ask for what they read: once per input, and again when the log changes. */
export const requestPanels = (model: Model): Step => {
	const log = model.log
	if (log === null) return { model, commands: [] }
	return requestTrace(requestContext({ model, commands: [] }, log), log)
}
