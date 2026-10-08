// SAFETY-FILE: JSON parsed in this test is the OTLP body the exporter under test serialized.
// The whole trace and log pipelines in a real document: batch processor,
// consent and status wrappers, the unload split and the exporter, down to `fetch`.
import {
	configurePrivacy,
	OTLP_UNLOAD_TAIL_BYTES,
	postToIngest,
	resetConsentForTests,
} from "@maple/browser-session"
import { context, trace } from "@opentelemetry/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetKeepaliveBudgetForTests } from "../../browser-session/src/platform/transport"
import { resolveConfig } from "./config"
import { startLogs } from "./deferred/logs"
import { emitLog, resetLogsForTests } from "./logs"
import { setupTracing } from "./tracing"

const KIB = 1024
const CONFIG = resolveConfig({
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	// Instrumented, so the export has to get past the patched `fetch` too.
	tracing: { instrumentFetch: true },
})

interface Sent {
	readonly url: string
	readonly keepalive: boolean
	readonly bytes: number
	/** Span names or log bodies in the request, in order. */
	readonly names: string[]
}

interface OtlpBody {
	readonly resourceSpans?: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<{ readonly name: string }> }>
	}>
	readonly resourceLogs?: ReadonlyArray<{
		readonly scopeLogs: ReadonlyArray<{
			readonly logRecords: ReadonlyArray<{ readonly body: { readonly stringValue: string } }>
		}>
	}>
}

const itemNames = (body: OtlpBody): string[] => [
	...(body.resourceSpans ?? []).flatMap((resource) =>
		resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
	),
	...(body.resourceLogs ?? []).flatMap((resource) =>
		resource.scopeLogs.flatMap((scope) => scope.logRecords.map((log) => log.body.stringValue)),
	),
]

const sent: Sent[] = []
/** Requests stay in flight, as they are while a document unloads, until this runs. */
let settle: () => void = () => {}
let shutdown: (() => Promise<void>) | undefined

beforeEach(() => {
	const inflight: Array<(response: Response) => void> = []
	let settled = false
	settle = () => {
		settled = true
		for (const resolve of inflight.splice(0)) resolve(new Response(null, { status: 200 }))
	}
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		const body = init.body
		sent.push({
			url,
			keepalive: init.keepalive === true,
			bytes: body instanceof Uint8Array ? body.byteLength : String(body).length,
			names:
				body instanceof Uint8Array
					? itemNames(JSON.parse(new TextDecoder().decode(body)) as OtlpBody)
					: [],
		})
		if (settled) return Promise.resolve(new Response(null, { status: 200 }))
		return new Promise<Response>((resolve) => inflight.push(resolve))
	})
})

afterEach(async () => {
	settle()
	await shutdown?.()
	shutdown = undefined
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	resetKeepaliveBudgetForTests()
	resetConsentForTests()
	resetLogsForTests()
	sent.length = 0
	trace.disable()
	context.disable()
})

/** End `count` spans named `s0`, `s1`, ... each padded by `padBytes`. */
const endSpans = (count: number, padBytes = KIB, prefix = "s"): string[] => {
	const names = Array.from({ length: count }, (_, i) => `${prefix}${i}`)
	for (const name of names) {
		trace
			.getTracer("test")
			.startSpan(name, { attributes: { pad: "x".repeat(padBytes) } })
			.end()
	}
	return names
}

const hide = (): void => {
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
	document.dispatchEvent(new Event("visibilitychange"))
}

describe("trace export on the way out", () => {
	it("issues the newest spans under keepalive inside the pagehide handler, then the rest", () => {
		shutdown = setupTracing(CONFIG)
		const names = endSpans(60)

		window.dispatchEvent(new Event("pagehide"))
		// No await since the event: both requests were created by the handler itself.
		expect(sent.map((request) => request.url)).toEqual([
			"https://ingest.test/v1/traces",
			"https://ingest.test/v1/traces",
		])
		const [tail, older] = sent
		const tailCount = tail?.names.length ?? 0
		expect(tail?.keepalive).toBe(true)
		expect(tail?.bytes).toBeLessThanOrEqual(OTLP_UNLOAD_TAIL_BYTES)
		expect(tailCount).toBeGreaterThan(5)
		expect(tail?.names).toEqual(names.slice(-tailCount))
		expect(older?.keepalive).toBe(false)
		expect(older?.names).toEqual(names.slice(0, -tailCount))

		// The session lifecycle's listener runs next; its `ended` row still gets keepalive.
		void postToIngest("https://ingest.test/v1/sessionReplays/meta", {}, "x".repeat(8 * KIB), true)
		expect(sent.at(-1)?.keepalive).toBe(true)

		// `visibilitychange` follows `pagehide` on a real unload: nothing is sent twice.
		hide()
		expect(sent).toHaveLength(3)
	})

	it("splits the same way when the document is hidden, each span in exactly one request", () => {
		shutdown = setupTracing(CONFIG)
		const names = endSpans(60)

		hide()
		expect(sent.map((request) => request.keepalive)).toEqual([true, false])
		expect([...(sent[1]?.names ?? []), ...(sent[0]?.names ?? [])]).toEqual(names)
	})

	it("splits each batch of a backlog larger than one, the newest spans still under keepalive", () => {
		shutdown = setupTracing(CONFIG)
		// The 512th span starts an export; while it is in flight the queue grows past one batch.
		endSpans(512, 64, "early")
		expect(sent).toHaveLength(1)
		const names = endSpans(600, 64)

		window.dispatchEvent(new Event("pagehide"))
		const [tailA, olderA, tailB, olderB] = sent.slice(1)
		expect(sent.slice(1).map((request) => request.keepalive)).toEqual([true, false, true, false])
		expect(tailB?.names.at(-1)).toBe("s599")
		expect((tailA?.bytes ?? 0) + (tailB?.bytes ?? 0)).toBeLessThanOrEqual(32 * KIB)
		expect([olderA, tailA, olderB, tailB].flatMap((request) => request?.names ?? [])).toEqual(names)
	})

	it("does not span its own requests while fetch is instrumented", async () => {
		shutdown = setupTracing(CONFIG)
		const names = endSpans(3)
		window.dispatchEvent(new Event("pagehide"))
		void postToIngest("https://ingest.test/v1/sessionReplays/meta", {}, "{}", true)

		settle()
		// A span for one of them would end 300ms after its response and export with the shutdown.
		await new Promise((resolve) => setTimeout(resolve, 350))
		await shutdown()
		shutdown = undefined
		expect(sent.flatMap((request) => request.names)).toEqual(names)
	})

	it("sends nothing while consent is withheld", () => {
		configurePrivacy({ requireConsent: true })
		shutdown = setupTracing(CONFIG)
		endSpans(3)

		window.dispatchEvent(new Event("pagehide"))
		expect(sent).toEqual([])
	})
})

describe("log export on the way out", () => {
	it("still gets keepalive for the exit logs after about 30 KiB of spans", async () => {
		const stopTracing = setupTracing(CONFIG)
		const stopLogs = startLogs(CONFIG)
		shutdown = async () => {
			await stopLogs()
			await stopTracing()
		}
		endSpans(24)
		const names = Array.from({ length: 20 }, (_, i) => `l${i}`)
		for (const body of names) emitLog({ severityNumber: 9, severityText: "INFO", body })

		// A real unload: `pagehide` flushes the spans, the `visibilitychange` after it the logs.
		window.dispatchEvent(new Event("pagehide"))
		expect(sent.map((request) => request.keepalive)).toEqual([true, false])
		expect((sent[0]?.bytes ?? 0) + (sent[1]?.bytes ?? 0)).toBeGreaterThan(28 * KIB)
		hide()
		await vi.waitFor(() => expect(sent).toHaveLength(3))
		expect(sent[2]).toMatchObject({ url: "https://ingest.test/v1/logs", keepalive: true, names })
	})

	it("sends the newest records under keepalive when the document is hidden, then the rest", async () => {
		shutdown = startLogs(CONFIG)
		const names = Array.from({ length: 60 }, (_, i) => `l${i}`)
		for (const body of names) {
			emitLog({ severityNumber: 9, severityText: "INFO", body, attributes: { pad: "x".repeat(KIB) } })
		}

		hide()
		// The log processor exports a few microtasks after its listener ran.
		await vi.waitFor(() => expect(sent).toHaveLength(2))
		expect(sent.map((request) => request.url)).toEqual([
			"https://ingest.test/v1/logs",
			"https://ingest.test/v1/logs",
		])
		const [tail, older] = sent
		const tailCount = tail?.names.length ?? 0
		expect(tail?.keepalive).toBe(true)
		expect(tail?.bytes).toBeLessThanOrEqual(OTLP_UNLOAD_TAIL_BYTES)
		expect(tailCount).toBeGreaterThan(5)
		expect(tail?.names).toEqual(names.slice(-tailCount))
		expect(older).toMatchObject({ keepalive: false, names: names.slice(0, -tailCount) })
	})
})
