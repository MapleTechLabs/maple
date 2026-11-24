// Test helpers: export each span as it ends, into memory. Not part of the bundle.
import { TraceFlags } from "@opentelemetry/api"
import {
	type ExportResult,
	ExportResultCode,
	type ReadableSpan,
	type SpanExporter,
	type SpanProcessor,
} from "./span"

export class InMemorySpanExporter implements SpanExporter {
	private spans: ReadableSpan[] = []

	export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
		this.spans.push(...spans)
		callback({ code: ExportResultCode.SUCCESS })
	}

	getFinishedSpans(): ReadableSpan[] {
		return this.spans
	}

	reset(): void {
		this.spans = []
	}

	shutdown(): Promise<void> {
		this.reset()
		return Promise.resolve()
	}
}

export class SimpleSpanProcessor implements SpanProcessor {
	constructor(private readonly options: { readonly exporter: SpanExporter }) {}

	onStart(): void {}

	onEnd(span: ReadableSpan): void {
		if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return
		this.options.exporter.export([span], () => {})
	}

	forceFlush(): Promise<void> {
		return Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.options.exporter.shutdown()
	}
}
