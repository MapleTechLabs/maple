// The batching queue behind spans and log records: export every `delayMs`, or
// as soon as a full batch is queued, and flush whenever the page is hidden.
import { context, diag, TraceFlags } from "@opentelemetry/api"
import { suppressTracing } from "./propagation"
import {
	type ExportResult,
	ExportResultCode,
	type ReadableSpan,
	type SpanExporter,
	type SpanProcessor,
} from "./span"

const MAX_QUEUE = 2048
const MAX_BATCH = 512
const EXPORT_TIMEOUT_MS = 30_000

export interface BatchExporter<T> {
	export(items: T[], callback: (result: ExportResult) => void): void
	forceFlush?(): Promise<void>
	shutdown(): Promise<void>
}

export class BatchQueue<T> {
	private queue: T[] = []
	private timer: ReturnType<typeof setTimeout> | undefined
	private exporting = false
	private shutdownPromise: Promise<void> | undefined
	private readonly listening: boolean
	private readonly onHidden = (): void => {
		if (document.visibilityState === "hidden") {
			this.forceFlush().catch((error: unknown) => diag.error("batch flush failed", error))
		}
	}

	/**
	 * `strict` (spans): export within the flush call, and a failed export fails the flush.
	 * Otherwise (logs): export a microtask later, and a failure is only logged.
	 */
	constructor(
		private readonly exporter: BatchExporter<T>,
		private readonly delayMs: number,
		private readonly strict: boolean,
	) {
		this.listening = typeof document !== "undefined" && typeof document.addEventListener === "function"
		if (this.listening) document.addEventListener("visibilitychange", this.onHidden)
	}

	add(item: T): void {
		if (this.shutdownPromise || this.queue.length >= MAX_QUEUE) return
		this.queue.push(item)
		this.maybeStartTimer()
	}

	forceFlush(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		return this.flushAll()
	}

	shutdown(): Promise<void> {
		this.shutdownPromise ??= Promise.resolve().then(async () => {
			if (this.listening) document.removeEventListener("visibilitychange", this.onHidden)
			await this.flushAll()
			await this.exporter.shutdown()
		})
		return this.shutdownPromise
	}

	private async flushAll(): Promise<void> {
		const batches = Math.ceil(this.queue.length / MAX_BATCH)
		await Promise.all(Array.from({ length: batches }, () => this.exportBatch()))
	}

	private exportBatch(): Promise<void> {
		this.clearTimer()
		if (this.queue.length === 0) return Promise.resolve()
		const batch = this.queue.splice(0, MAX_BATCH)
		const exported = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout")), EXPORT_TIMEOUT_MS)
			// The exporter's own request must not be traced.
			const run = (): void =>
				context.with(suppressTracing(context.active()), () =>
					this.exporter.export(batch, (result) => {
						clearTimeout(timer)
						if (result.code === ExportResultCode.SUCCESS) resolve()
						else reject(result.error ?? new Error("export failed"))
					}),
				)
			// Spans export within the flush call, which an unload needs; log records a
			// microtask later, as the OTel logs processor did, so a page's exit flush
			// sends its spans first and the logs take the keepalive room they leave.
			if (this.strict) run()
			else {
				// An exporter that throws (a cyclic log body) fails this export now, as one that reports failure.
				Promise.resolve()
					.then(run)
					.catch((error: unknown) => {
						clearTimeout(timer)
						reject(error)
					})
			}
		})
		return this.strict
			? exported
			: exported.catch((error: unknown) => diag.error("batch export failed", error))
	}

	private maybeStartTimer(): void {
		if (this.exporting) return
		const flush = (): void => {
			this.exporting = true
			this.exportBatch()
				.catch((error: unknown) => diag.error("batch export failed", error))
				.finally(() => {
					this.exporting = false
					if (this.queue.length > 0) {
						this.clearTimer()
						this.maybeStartTimer()
					}
				})
		}
		if (this.queue.length >= MAX_BATCH) return flush()
		if (this.timer !== undefined) return
		this.timer = setTimeout(flush, this.delayMs)
	}

	private clearTimer(): void {
		if (this.timer === undefined) return
		clearTimeout(this.timer)
		this.timer = undefined
	}
}

/** Queues sampled spans as they end and exports them in batches. */
export class BatchSpanProcessor implements SpanProcessor {
	private readonly queue: BatchQueue<ReadableSpan>

	constructor(options: { readonly exporter: SpanExporter; readonly scheduledDelayMillis: number }) {
		this.queue = new BatchQueue(options.exporter, options.scheduledDelayMillis, true)
	}

	onStart(): void {}

	onEnd(span: ReadableSpan): void {
		if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0) this.queue.add(span)
	}

	forceFlush(): Promise<void> {
		return this.queue.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.queue.shutdown()
	}
}
