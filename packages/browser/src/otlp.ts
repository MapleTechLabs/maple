// OTLP/JSON export for spans and log records over the session transport, so
// every request this SDK sends spends from one keepalive budget. The browser
// caps a document's in-flight keepalive bodies at 64 KiB combined; an exporter
// keeping an account of its own could push a session row past that.
import { postToIngest } from "@maple/browser-session"

/** OTLP's ceiling within the shared 48 KiB keepalive budget; the rest stays free for the session's final rows. */
const KEEPALIVE_CEILING_BYTES = 32 * 1024

/** Max body of the newest items a hidden or unloading document sends first. */
const UNLOAD_TAIL_BYTES = 16 * 1024

// The retry policy of OpenTelemetry's OTLP/HTTP exporter, which this replaces.
const EXPORT_TIMEOUT_MS = 10_000
const RETRYABLE_STATUS = [429, 502, 503, 504]

interface ExportResult {
	readonly code: number
	readonly error?: Error
}

interface Serializer<T> {
	serializeRequest(items: T[]): Uint8Array | undefined
}

interface Exporter<T> {
	export(items: T[], callback: (result: ExportResult) => void): void
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}

/** One POST, aborted at `timeoutMs`. Resolves with what went wrong, if anything. */
function attempt(
	url: string,
	headers: Record<string, string>,
	body: Uint8Array,
	timeoutMs: number,
): Promise<{ readonly error: Error; readonly retryable: boolean } | undefined> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	return postToIngest(url, headers, body, true, {
		signal: controller.signal,
		keepaliveCeiling: KEEPALIVE_CEILING_BYTES,
	})
		.then(
			(response) =>
				response.ok
					? undefined
					: {
							error: new Error(`OTLP export failed with status ${response.status}`),
							retryable: RETRYABLE_STATUS.includes(response.status),
						},
			// A network error is a TypeError; the timeout's abort is not, and ends the export.
			(cause: unknown) => ({
				error: new Error("OTLP export failed", { cause }),
				retryable: cause instanceof TypeError,
			}),
		)
		.finally(() => clearTimeout(timer))
}

/**
 * Send one body, retrying 429/502/503/504 and network errors with a jittered
 * backoff (1s, growing 1.5x) until the next wait would pass the deadline. The
 * first request is issued before this returns, which an unload flush needs.
 */
async function send(url: string, headers: Record<string, string>, body: Uint8Array): Promise<ExportResult> {
	const deadline = Date.now() + EXPORT_TIMEOUT_MS
	let backoff = 1_000
	for (;;) {
		const failure = await attempt(url, headers, body, deadline - Date.now())
		if (!failure) return { code: 0 }
		const wait = backoff * (0.8 + Math.random() * 0.4)
		if (!failure.retryable || wait > deadline - Date.now()) return { code: 1, error: failure.error }
		backoff *= 1.5
		await new Promise((resolve) => setTimeout(resolve, wait))
	}
}

/** Exports each batch as one OTLP/JSON request to `url`. */
export class OtlpExporter<T> implements Exporter<T> {
	private readonly inflight = new Set<Promise<void>>()

	constructor(
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly serializer: Serializer<T>,
	) {}

	export(items: T[], callback: (result: ExportResult) => void): void {
		const body = this.serializer.serializeRequest(items)
		if (!body) {
			callback({ code: 1, error: new Error("Nothing to send") })
			return
		}
		const headers = { ...this.headers, "content-type": "application/json" }
		const sent = send(this.url, headers, body).then(callback)
		this.inflight.add(sent)
		void sent.finally(() => this.inflight.delete(sent))
	}

	/** Resolves once every export in flight has reported its result. */
	async forceFlush(): Promise<void> {
		await Promise.all(this.inflight)
	}

	shutdown(): Promise<void> {
		return this.forceFlush()
	}
}

let unloading = false

/**
 * Run a `pagehide` flush. The document still reads as visible there, so the
 * flush says it is leaving; `flush` must issue its exports before it returns.
 */
export function flushUnloading(flush: () => void): void {
	unloading = true
	flush()
	unloading = false
}

/** The newest items whose body fits `UNLOAD_TAIL_BYTES`, then everything older. A larger single item travels alone. */
function newestFirst<T>(items: T[], serializer: Serializer<T>): T[][] {
	const size = (from: number): number => serializer.serializeRequest(items.slice(from))?.byteLength ?? 0
	let start = items.length - 1
	while (start > 0 && size(start - 1) <= UNLOAD_TAIL_BYTES) start -= 1
	return start > 0 ? [items.slice(start), items.slice(0, start)] : [items]
}

/**
 * A hidden or unloading document may not live to see a response, and a batch
 * past the keepalive ceiling goes out as a plain request that the browser
 * terminates with the document. There each batch becomes two exports: its
 * newest items first, in a body small enough for keepalive, then the rest.
 * Each reports to `inner` on its own, so only the part that failed is queued.
 */
export function newestFirstOnExit<T>(inner: Exporter<T>, serializer: Serializer<T>): Exporter<T> {
	return {
		export(items, callback) {
			const hidden = typeof document !== "undefined" && document.visibilityState === "hidden"
			const parts = unloading || hidden ? newestFirst(items, serializer) : [items]
			let pending = parts.length
			let failed: ExportResult | undefined
			for (const part of parts) {
				inner.export(part, (result) => {
					if (result.code !== 0) failed = result
					pending -= 1
					if (pending === 0) callback(failed ?? result)
				})
			}
		},
		forceFlush: () => inner.forceFlush(),
		shutdown: () => inner.shutdown(),
	}
}
