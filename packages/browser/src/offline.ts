// The eager half of the offline queue: span batches the exporter gave up on
// (after its own retries) are handed to the deferred chunk, which stores them
// and sends them again once the browser is back online.
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

type SpanStash = (spans: ReadableSpan[]) => void

/** Failed batches held until the deferred chunk lands. */
const MAX_HELD = 20

let stash: SpanStash | undefined
let held: ReadableSpan[][] = []

export function attachSpanStash(next: SpanStash | undefined): void {
	stash = next
	if (!next) return
	const pending = held
	held = []
	for (const spans of pending) next(spans)
}

export class OfflineSpanExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
		this.inner.export(spans, (result) => {
			if (result.code !== 0) {
				if (stash) stash(spans)
				else {
					held.push(spans)
					if (held.length > MAX_HELD) held.shift()
				}
			}
			callback(result)
		})
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

/** Test seam. */
export function resetOfflineForTests(): void {
	stash = undefined
	held = []
}
