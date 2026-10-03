// The eager half of the logs pipeline. Records queue here, stamped and linked
// to the active span at emit time, until the deferred chunk attaches the OTel
// LoggerProvider that exports them.
import { hasConsent, readSessionSink } from "@maple/browser-session"
import type { LogAttributeValue, SignalLogRecord, SpanLink } from "@maple/sdk-core"
import { context, trace } from "@opentelemetry/api"

export type { LogAttributeValue } from "@maple/sdk-core"
export { Severity } from "@maple/sdk-core"

export interface QueuedLogRecord extends SignalLogRecord {
	readonly timestamp: number
	readonly attributes: Readonly<Record<string, LogAttributeValue>>
	readonly link: SpanLink | undefined
}

type LogSink = (record: QueuedLogRecord) => void

/** Held until the deferred chunk lands; beyond this, a page logging in a loop drops the oldest. */
const MAX_QUEUED = 200

let queue: QueuedLogRecord[] = []
let sink: LogSink | undefined
let getUserId: () => string | undefined = () => undefined

export function emitLog(record: SignalLogRecord): void {
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
		link: record.link ?? trace.getSpanContext(context.active()),
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
