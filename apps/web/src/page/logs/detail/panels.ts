import { formatWarehouseDateTime, formatWarehouseDateTimeMs } from "@maple/query-engine"
import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { computeTraceTimeWindow } from "@maple/web-data/lib/trace-time-window"
import { listLogs } from "@maple/web-data/warehouse/logs"
import { getSpanHierarchy } from "@maple/web-data/warehouse/traces"
import { TraceId } from "@maple/domain"
import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { toLoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { LogRecord } from "../../../ui/logs/log-row-view"
import { Message, type Model } from "./model"

// The reads behind `LogTraceTimeline` and `LogContextPanel`, sent while their panel is on show.

const CONTEXT_SIZE = 25
const CONTEXT_WINDOW_MS = 60 * 60 * 1000
export const TRACE_LOG_LIMIT = 200
const INSTANCE_KEYS = ["k8s.pod.name", "service.instance.id"] as const
const WAREHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/

type Cmd = Command.Command<Message, never, Resources>

const InstanceAttribute = Schema.Struct({ key: Schema.String, value: Schema.String })
export type InstanceAttribute = typeof InstanceAttribute.Type

const Side = Schema.Literals(["before", "after"])
type Side = typeof Side.Type

/** `instanceAttribute`: the most specific resource attribute that names one running instance. */
export const instanceAttribute = (log: LogRecord): InstanceAttribute | undefined => {
	const key = INSTANCE_KEYS.find((candidate) => (log.resourceAttributes[candidate] ?? "") !== "")
	return key === undefined ? undefined : { key, value: log.resourceAttributes[key] ?? "" }
}

/** `contextKey`: the record hash when the row has one, else timestamp, span and body. */
export const contextKey = (log: LogRecord): string =>
	log.recordIdentity ?? `${log.exactTimestamp}|${log.spanId ?? ""}|${log.body}`

export const timestampMs = (timestamp: string): number =>
	new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`).getTime()

/** The scope in effect: the instance when the log names one and it is chosen. */
export const scopedInstance = (model: Model, log: LogRecord): InstanceAttribute | undefined => {
	const instance = instanceAttribute(log)
	return instance !== undefined && model.contextScope.values[0] === "instance" ? instance : undefined
}

/** `applyGlobalNamespace(data, "top")`: the pin is the only namespace filter. */
const pinned = (pinnedNamespace: string | null) =>
	pinnedNamespace === null ? {} : { namespaces: [pinnedNamespace] }

/** `contextInputs`: 25 logs each side within an hour; both sides include this instant. */
export const contextInput = (
	log: LogRecord,
	instance: InstanceAttribute | undefined,
	side: Side,
	pinnedNamespace: string | null,
) => {
	const ms = timestampMs(log.timestamp)
	if (Number.isNaN(ms)) return undefined
	const at = WAREHOUSE_DATETIME.test(log.exactTimestamp)
		? log.exactTimestamp
		: formatWarehouseDateTimeMs(ms)
	const shared = {
		services: [log.serviceName],
		limit: CONTEXT_SIZE + 1,
		resourceAttributeFilters:
			instance === undefined
				? undefined
				: [{ key: instance.key, value: instance.value, mode: "equals" as const }],
		...pinned(pinnedNamespace),
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
		rows.filter((row) => {
			const key = contextKey(row)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	const before = unique(beforeDesc).slice(0, CONTEXT_SIZE).toReversed()
	const after = unique(afterAsc).slice(0, CONTEXT_SIZE)
	return [...before, selected, ...after]
}

/** `listLogsResultAtom({ data: before | after })`. */
export const FetchContext = Command.define("FetchLogContext", {
	args: {
		key: Schema.String,
		side: Side,
		log: LogRecord,
		instance: Schema.UndefinedOr(InstanceAttribute),
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedFetchContext],
	execute: ({ key, side, log, instance, pinnedNamespace }) =>
		Effect.suspend(() => listLogs({ data: contextInput(log, instance, side, pinnedNamespace) ?? {} })).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
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
		listLogs({ data: traceLogsInput(traceId, timestamp, pinnedNamespace) }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraceLogs({ key, result })),
		),
})

/** `getSpanHierarchyResultAtom({ traceId, timestamp })`: span names and the trace's start. */
export const FetchTraceSpans = Command.define("FetchLogTraceSpans", {
	args: { key: Schema.String, traceId: TraceId, timestamp: Schema.String },
	messages: [Message.CompletedFetchTraceSpans],
	execute: ({ key, traceId, timestamp }) =>
		getSpanHierarchy({ data: { traceId, timestamp } }).pipe(
			Effect.map((response) => ({
				traceStartTime: response.traceStartTime ?? null,
				spanNames: response.spans.map((span) => ({ spanId: span.spanId, spanName: span.spanName })),
			})),
			Effect.mapError(toLoadFailure),
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

export const traceLogsInput = (traceId: TraceId, timestamp: string, pinnedNamespace: string | null) => ({
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

const requestContext = (step: Step, log: LogRecord): Step => {
	if (!isShowing(step.model, "context")) return step
	const instance = scopedInstance(step.model, log)
	return (["before", "after"] as const).reduce((acc, side) => {
		const key = contextKeyOf(acc.model, log, side)
		if (key === undefined) return acc
		return side === "before"
			? slotStep(
					acc,
					(m) => m.contextBefore,
					key,
					(m, contextBefore) => ({ ...m, contextBefore }),
					FetchContext({ key, side, log, instance, pinnedNamespace: acc.model.pinnedNamespace }),
				)
			: slotStep(
					acc,
					(m) => m.contextAfter,
					key,
					(m, contextAfter) => ({ ...m, contextAfter }),
					FetchContext({ key, side, log, instance, pinnedNamespace: acc.model.pinnedNamespace }),
				)
	}, step)
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
