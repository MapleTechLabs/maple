// Log records and the provider that batches them, shaped like the OTel JS
// sdk-logs `ReadableLogRecord` the OTLP encoder reads.
import {
	type Attributes,
	context as contextApi,
	diag,
	type HrTime,
	isSpanContextValid,
	type LogRecord,
	type SpanContext,
	trace,
} from "@opentelemetry/api"
import { addAttribute } from "./attributes"
import { type BatchExporter, BatchQueue } from "./batch"
import type { InstrumentationScope, Resource } from "./span"
import { timeInputToHrTime } from "./time"

export interface ReadableLogRecord {
	readonly hrTime: HrTime
	readonly hrTimeObserved: HrTime
	readonly spanContext?: SpanContext | undefined
	readonly severityNumber?: LogRecord["severityNumber"]
	readonly severityText?: string | undefined
	readonly body?: LogRecord["body"]
	readonly eventName?: string | undefined
	readonly attributes: Attributes
	readonly droppedAttributesCount: number
	readonly resource: Resource
	readonly instrumentationScope: InstrumentationScope
}

export type LogRecordExporter = BatchExporter<ReadableLogRecord>

export interface LogRecordProcessor {
	onEmit(record: ReadableLogRecord): void
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}

export class BatchLogRecordProcessor implements LogRecordProcessor {
	private readonly queue: BatchQueue<ReadableLogRecord>

	constructor(options: { readonly exporter: LogRecordExporter; readonly scheduledDelayMillis: number }) {
		this.queue = new BatchQueue(options.exporter, options.scheduledDelayMillis, false)
	}

	onEmit(record: ReadableLogRecord): void {
		this.queue.add(record)
	}

	forceFlush(): Promise<void> {
		return this.queue.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.queue.shutdown()
	}
}

/** One record as emitted: valid span context only, attributes validated and capped. */
function toRecord(
	log: LogRecord,
	resource: Resource,
	instrumentationScope: InstrumentationScope,
): ReadableLogRecord {
	const now = Date.now()
	const spanContext = trace.getSpanContext(log.context ?? contextApi.active())
	const attributes: Attributes = {}
	let count = 0
	let dropped = 0
	for (const [key, value] of Object.entries(log.attributes ?? {})) {
		const decision = addAttribute(attributes, count, key, value)
		if (decision === "added") count += 1
		else if (decision === "limit") {
			dropped += 1
			if (dropped === 1) diag.warn("Dropping extra attributes.")
		}
	}
	return {
		hrTime: timeInputToHrTime(log.timestamp ?? now),
		hrTimeObserved: timeInputToHrTime(log.observedTimestamp ?? now),
		spanContext: spanContext && isSpanContextValid(spanContext) ? spanContext : undefined,
		severityNumber: log.severityNumber,
		severityText: log.severityText,
		body: log.body,
		eventName: log.eventName,
		attributes,
		droppedAttributesCount: dropped,
		resource,
		instrumentationScope,
	}
}

export interface Logger {
	emit(log: LogRecord): void
}

export class LoggerProvider {
	private readonly loggers = new Map<string, Logger>()
	private readonly resource: Resource
	private readonly processors: ReadonlyArray<LogRecordProcessor>
	private stopped = false

	constructor(options: {
		readonly resource: Resource
		readonly processors: ReadonlyArray<LogRecordProcessor>
	}) {
		this.resource = options.resource
		this.processors = options.processors
	}

	getLogger(name: string, version?: string): Logger {
		const key = `${name}@${version ?? ""}:`
		const existing = this.loggers.get(key)
		if (existing) return existing
		const scope: InstrumentationScope = { name, version }
		const logger: Logger = {
			emit: (log) => {
				if (this.stopped) return
				const record = toRecord(log, this.resource, scope)
				for (const processor of this.processors) processor.onEmit(record)
			},
		}
		this.loggers.set(key, logger)
		return logger
	}

	async forceFlush(): Promise<void> {
		await Promise.all(this.processors.map((processor) => processor.forceFlush()))
	}

	async shutdown(): Promise<void> {
		this.stopped = true
		await Promise.all(this.processors.map((processor) => processor.shutdown()))
	}
}
