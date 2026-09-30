// The eager half of the logs pipeline. Records queue here, stamped and linked
// to the active span at emit time, until the deferred chunk attaches the OTel
// LoggerProvider that exports them.
import { hasConsent, readSessionSink } from "@maple/browser-session"
import { context, type SpanContext, trace } from "@opentelemetry/api"

export type LogAttributeValue = string | number | boolean

/** OTel severity numbers for the levels this SDK emits. */
export const Severity = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const

export interface MapleLogRecord {
	/** Set for a log-based event (`LogRecord.event_name`); absent for a plain log line. */
	readonly eventName?: string | undefined
	readonly severityNumber: number
	readonly severityText: string
	readonly body?: string | undefined
	readonly attributes?: Readonly<Record<string, LogAttributeValue>> | undefined
	/** Epoch ms when it happened. Defaults to now. */
	readonly timestamp?: number | undefined
	/** The span to link to. Defaults to the active span. */
	readonly spanContext?: SpanContext | undefined
}

export interface QueuedLogRecord extends MapleLogRecord {
	readonly timestamp: number
	readonly attributes: Readonly<Record<string, LogAttributeValue>>
}

type LogSink = (record: QueuedLogRecord) => void

/** Held until the deferred chunk lands; beyond this, a page logging in a loop drops the oldest. */
const MAX_QUEUED = 200

let queue: QueuedLogRecord[] = []
let sink: LogSink | undefined
let getUserId: () => string | undefined = () => undefined

export function emitLog(record: MapleLogRecord): void {
	if (!hasConsent()) return
	const sessionId = readSessionSink()?.sessionId
	const userId = getUserId()
	const attributes = {
		...record.attributes,
		...(sessionId !== undefined ? { "session.id": sessionId } : undefined),
		...(userId !== undefined ? { "user.id": userId } : undefined),
	}
	const queued: QueuedLogRecord = {
		...record,
		attributes,
		timestamp: record.timestamp ?? Date.now(),
		spanContext: record.spanContext ?? trace.getSpanContext(context.active()),
	}
	if (sink) {
		sink(queued)
		return
	}
	queue.push(queued)
	if (queue.length > MAX_QUEUED) queue.shift()
}

/** Called by `init()`: where `user.id` comes from. */
export function setLogIdentity(read: () => string | undefined): void {
	getUserId = read
}

/** Called by the deferred chunk: drains the queue into `next`, then sends straight to it. */
export function attachLogSink(next: LogSink): void {
	sink = next
	const pending = queue
	queue = []
	for (const record of pending) next(record)
}

export function detachLogSink(): void {
	sink = undefined
	getUserId = () => undefined
}

/** Test seam. */
export function resetLogsForTests(): void {
	queue = []
	detachLogSink()
}
