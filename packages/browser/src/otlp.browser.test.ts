// SAFETY-FILE: JSON parsed in this test is the OTLP body the exporter under test serialized.
// The whole trace pipeline in a real document: batch processor, consent and
// status wrappers, the unload split and the exporter, down to `fetch`.
import { configurePrivacy, postToIngest, resetConsentForTests } from "@maple/browser-session"
import { context, trace } from "@opentelemetry/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetKeepaliveBudgetForTests } from "../../browser-session/src/platform/transport"
import { resolveConfig } from "./config"
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
	/** Span names in the body, in order. */
	readonly names: string[]
}

interface OtlpBody {
	readonly resourceSpans: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<{ readonly name: string }> }>
	}>
}

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
					? (JSON.parse(new TextDecoder().decode(body)) as OtlpBody).resourceSpans.flatMap(
							(resource) =>
								resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
						)
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
	sent.length = 0
	trace.disable()
	context.disable()
})

/** End `count` spans named `s0`, `s1`, ... of about 1 KiB each. */
const endSpans = (count: number): string[] => {
	const names = Array.from({ length: count }, (_, i) => `s${i}`)
	for (const name of names) {
		trace
			.getTracer("test")
			.startSpan(name, { attributes: { pad: "x".repeat(KIB) } })
			.end()
	}
	return names
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
		expect(tail?.bytes).toBeLessThanOrEqual(16 * KIB)
		expect(tailCount).toBeGreaterThan(5)
		expect(tail?.names).toEqual(names.slice(-tailCount))
		expect(older?.keepalive).toBe(false)
		expect(older?.names).toEqual(names.slice(0, -tailCount))

		// The session lifecycle's listener runs next; its `ended` row still gets keepalive.
		void postToIngest("https://ingest.test/v1/sessionReplays/meta", {}, "x".repeat(8 * KIB), true)
		expect(sent.at(-1)?.keepalive).toBe(true)

		// `visibilitychange` follows `pagehide` on a real unload: nothing is sent twice.
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		document.dispatchEvent(new Event("visibilitychange"))
		expect(sent).toHaveLength(3)
	})

	it("splits the same way when the document is hidden, each span in exactly one request", () => {
		shutdown = setupTracing(CONFIG)
		const names = endSpans(60)

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		document.dispatchEvent(new Event("visibilitychange"))
		expect(sent.map((request) => request.keepalive)).toEqual([true, false])
		expect([...(sent[1]?.names ?? []), ...(sent[0]?.names ?? [])]).toEqual(names)
	})

	it("sends nothing while consent is withheld", () => {
		configurePrivacy({ requireConsent: true })
		shutdown = setupTracing(CONFIG)
		endSpans(3)

		window.dispatchEvent(new Event("pagehide"))
		expect(sent).toEqual([])
	})
})
