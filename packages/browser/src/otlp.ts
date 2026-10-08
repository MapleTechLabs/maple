// OTLP/JSON export for spans and log records over the session transport, so
// every keepalive request this SDK sends spends from one budget. The browser
// caps a document's in-flight keepalive bodies at 64 KiB combined; an exporter
// keeping an account of its own could push a session row past that.
import { OTLP_UNLOAD_TAIL_BYTES, otlpKeepaliveRoom, postToIngest } from "@maple/browser-session"
import type { ISerializer } from "@opentelemetry/otlp-transformer"

// Timeout and retryable statuses of OpenTelemetry's OTLP/HTTP exporter, which this replaces.
const EXPORT_TIMEOUT_MS = 10_000
const RETRYABLE_STATUS = [429, 502, 503, 504]

interface ExportResult {
	readonly code: number
	readonly error?: Error
}

type Serializer<T> = ISerializer<T[], unknown>

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
	return postToIngest(url, headers, body, true, { signal: controller.signal, otlp: true })
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
 * Send one body, retrying with a jittered backoff (1s, growing 1.5x) until the
 * next wait would pass the deadline. The first request is issued before this
 * returns, which an unload flush needs.
 */
async function send(url: string, headers: Record<string, string>, body: Uint8Array): Promise<ExportResult> {
	const deadline = Date.now() + EXPORT_TIMEOUT_MS
	let timeoutMs = EXPORT_TIMEOUT_MS
	let backoff = 1_000
	for (;;) {
		const failure = await attempt(url, headers, body, timeoutMs)
		if (!failure) return { code: 0 }
		const wait = backoff * (0.8 + Math.random() * 0.4)
		// A retry may run for what was left when it was scheduled.
		timeoutMs = deadline - Date.now()
		if (!failure.retryable || wait > timeoutMs) return { code: 1, error: failure.error }
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
		const sent = send(this.url, headers, body)
			.then(callback)
			// A callback that throws must not surface in the host page or fail a later shutdown.
			.catch(() => {})
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
	try {
		flush()
	} finally {
		unloading = false
	}
}

/**
 * The newest items whose body fits what keepalive has room for right now, at
 * most `OTLP_UNLOAD_TAIL_BYTES`, then everything older. No split when nothing
 * or everything fits.
 */
function newestFirst<T>(items: T[], serializer: Serializer<T>): T[][] {
	const limit = Math.min(OTLP_UNLOAD_TAIL_BYTES, otlpKeepaliveRoom())
	const size = (from: number): number => serializer.serializeRequest(items.slice(from))?.byteLength ?? 0
	let start = items.length
	while (start > 0 && size(start - 1) <= limit) start -= 1
	return start > 0 && start < items.length ? [items.slice(start), items.slice(0, start)] : [items]
}

/**
 * A hidden or unloading document may not live to see a response, and a batch
 * past OTLP's keepalive share goes out as a plain request that the browser
 * terminates with the document. There each batch becomes two exports: its
 * newest items first, in a body small enough for keepalive, then the rest.
 * Each goes through `inner` on its own, so only the part that failed is queued.
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
