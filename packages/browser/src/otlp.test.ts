// SAFETY-FILE: JSON parsed in this test is the OTLP body the exporter under test serialized.
import { postToIngest } from "@maple/browser-session"
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetKeepaliveBudgetForTests } from "../../browser-session/src/platform/transport"
import { attachSpanStash, OfflineSpanExporter, resetOfflineForTests } from "./offline"
import { flushUnloading, newestFirstOnExit, OtlpExporter } from "./otlp"

const TRACES = "https://ingest.test/v1/traces"
const KIB = 1024

/** `count` finished spans named `s0`, `s1`, ... of roughly `padBytes` each. */
const spans = (count: number, padBytes = 0): ReadableSpan[] => {
	const memory = new InMemorySpanExporter()
	const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).getTracer(
		"t",
	)
	for (let i = 0; i < count; i++) {
		tracer.startSpan(`s${i}`, { attributes: { pad: "x".repeat(padBytes) } }).end()
	}
	return memory.getFinishedSpans()
}

interface Sent {
	readonly url: string
	readonly keepalive: boolean
	readonly bytes: number
	/** Span names in the body, in order. */
	readonly names: string[]
	readonly headers: Record<string, string>
}

interface OtlpBody {
	readonly resourceSpans: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<{ readonly name: string }> }>
	}>
}

const sent: Sent[] = []
/** What ingest answers, one entry per request; the last one repeats. */
let answers: Array<number | Error | "pending"> = [200]

beforeEach(() => {
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		const body = init.body
		const names =
			body instanceof Uint8Array
				? (JSON.parse(new TextDecoder().decode(body)) as OtlpBody).resourceSpans.flatMap((resource) =>
						resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
					)
				: []
		sent.push({
			url,
			keepalive: init.keepalive === true,
			bytes: body instanceof Uint8Array ? body.byteLength : String(body).length,
			names,
			headers: init.headers as Record<string, string>,
		})
		const answer = answers.length > 1 ? answers.shift() : answers[0]
		if (answer instanceof Error) return Promise.reject(answer)
		if (answer === "pending") {
			// In flight until its signal aborts it.
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
			})
		}
		return Promise.resolve(new Response(null, { status: answer }))
	})
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	resetKeepaliveBudgetForTests()
	resetOfflineForTests()
	sent.length = 0
	answers = [200]
})

const otlp = () => new OtlpExporter<ReadableSpan>(TRACES, { authorization: "Bearer k" }, JsonTraceSerializer)

/** Export one batch, collecting every result the exporter reports for it. */
const exportBatch = (
	exporter: { export: OtlpExporter<ReadableSpan>["export"] },
	batch: ReadableSpan[],
): Array<{ code: number; error?: Error }> => {
	const results: Array<{ code: number; error?: Error }> = []
	exporter.export(batch, (result) => results.push(result))
	return results
}

/** Whether the shared budget is whole again: a body that needs all of it still gets keepalive. */
const budgetIsFree = async (): Promise<boolean> => {
	await postToIngest("https://ingest.test/probe", {}, "x".repeat(48 * KIB), true)
	return sent.at(-1)?.keepalive === true
}

const names = (batch: ReadableSpan[]): string[] => batch.map((span) => span.name)

describe("OtlpExporter", () => {
	it("posts a batch as one OTLP/JSON keepalive request with the ingest headers", async () => {
		const results = exportBatch(otlp(), spans(2))
		await vi.waitFor(() => expect(results).toEqual([{ code: 0 }]))

		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ url: TRACES, keepalive: true, names: ["s0", "s1"] })
		expect(sent[0]?.headers).toEqual({ authorization: "Bearer k", "content-type": "application/json" })
	})

	it("issues the request before export returns", () => {
		exportBatch(otlp(), spans(1))
		expect(sent).toHaveLength(1)
	})

	it("spends the shared keepalive budget while in flight, under its own ceiling", async () => {
		vi.useFakeTimers()
		answers = ["pending"]
		const exporter = otlp()
		exportBatch(exporter, spans(16, KIB))
		exportBatch(exporter, spans(16, KIB))
		// Two bodies of about 20 KiB pass the 32 KiB ceiling: the second goes out plain.
		expect(sent.map((request) => request.keepalive)).toEqual([true, false])

		// The session's rows still have the rest of the 48 KiB budget.
		void postToIngest("https://ingest.test/v1/sessionReplays/meta", {}, "x".repeat(16 * KIB), true)
		expect(sent.at(-1)?.keepalive).toBe(true)
	})

	it("reports a rejected batch once, without retrying it", async () => {
		answers = [400]
		const results = exportBatch(otlp(), spans(1))
		await vi.waitFor(() => expect(results).toHaveLength(1))

		expect(results[0]?.code).toBe(1)
		expect(results[0]?.error?.message).toContain("400")
		expect(sent).toHaveLength(1)
		expect(await budgetIsFree()).toBe(true)
	})

	it("retries a retryable status and a network error with the same batch until it lands", async () => {
		vi.useFakeTimers()
		answers = [503, new TypeError("Failed to fetch"), 200]
		const results = exportBatch(otlp(), spans(2))
		await vi.advanceTimersByTimeAsync(5_000)

		expect(results).toEqual([{ code: 0 }])
		expect(sent.map((request) => request.names)).toEqual([
			["s0", "s1"],
			["s0", "s1"],
			["s0", "s1"],
		])
		expect(await budgetIsFree()).toBe(true)
	})

	it("stops retrying at the 10s deadline and reports the failure once", async () => {
		vi.useFakeTimers()
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		answers = [503]
		const results = exportBatch(otlp(), spans(1))
		await vi.advanceTimersByTimeAsync(30_000)

		// Waits of 1s, 1.5s, 2.25s and 3.375s fit the deadline; the next would not.
		expect(sent).toHaveLength(5)
		expect(results).toHaveLength(1)
		expect(results[0]?.code).toBe(1)
		expect(await budgetIsFree()).toBe(true)
	})

	it("aborts a request that outlives the deadline, releasing its reservation", async () => {
		vi.useFakeTimers()
		answers = ["pending"]
		const results = exportBatch(otlp(), spans(1))
		await vi.advanceTimersByTimeAsync(10_000)

		expect(results).toHaveLength(1)
		expect(results[0]?.code).toBe(1)
		expect(sent).toHaveLength(1)
		answers = [200]
		expect(await budgetIsFree()).toBe(true)
	})

	it("resolves shutdown only after the exports in flight have reported", async () => {
		vi.useFakeTimers()
		answers = [503, 200]
		const exporter = otlp()
		const results = exportBatch(exporter, spans(1))
		let closed = false
		void exporter.shutdown().then(() => {
			closed = true
		})
		await vi.advanceTimersByTimeAsync(500)
		expect(closed).toBe(false)

		await vi.advanceTimersByTimeAsync(1_000)
		expect(results).toEqual([{ code: 0 }])
		expect(closed).toBe(true)
	})

	it("queues a batch for the offline resend only when the exporter gave up on it", async () => {
		vi.useFakeTimers()
		const stashed: string[][] = []
		attachSpanStash((batch) => stashed.push(names(batch)))
		const exporter = new OfflineSpanExporter(otlp())

		answers = [503, 200]
		exportBatch(exporter, spans(1))
		await vi.advanceTimersByTimeAsync(2_000)
		expect(stashed).toEqual([])

		answers = [new TypeError("Failed to fetch")]
		const results = exportBatch(exporter, spans(2))
		await vi.advanceTimersByTimeAsync(30_000)
		expect(results).toHaveLength(1)
		expect(stashed).toEqual([["s0", "s1"]])
	})
})

describe("newestFirstOnExit", () => {
	const UNLOAD_TAIL_BYTES = 16 * KIB
	const size = (batch: ReadableSpan[]): number =>
		JsonTraceSerializer.serializeRequest(batch)?.byteLength ?? 0

	it("leaves a batch whole while the document is visible", () => {
		exportBatch(newestFirstOnExit(otlp(), JsonTraceSerializer), spans(60, KIB))
		expect(sent).toHaveLength(1)
		expect(sent[0]?.names).toHaveLength(60)
	})

	it("sends the newest spans first under keepalive when unloading, leaving room for the session row", () => {
		vi.useFakeTimers()
		answers = ["pending"]
		const batch = spans(60, KIB)
		expect(size(batch)).toBeGreaterThan(60 * KIB)
		const exporter = newestFirstOnExit(otlp(), JsonTraceSerializer)
		flushUnloading(() => exportBatch(exporter, batch))

		// Both requests exist before the unload handler would have returned.
		expect(sent).toHaveLength(2)
		const [tail, older] = sent
		const tailCount = tail?.names.length ?? 0
		expect(tail?.keepalive).toBe(true)
		expect(tail?.bytes).toBeLessThanOrEqual(UNLOAD_TAIL_BYTES)
		expect(tail?.names).toEqual(names(batch).slice(-tailCount))
		// As many as fit: one more span would have passed the limit.
		expect(size(batch.slice(-tailCount - 1))).toBeGreaterThan(UNLOAD_TAIL_BYTES)
		// Past the ceiling, so plain; and no span is in both requests.
		expect(older?.keepalive).toBe(false)
		expect(older?.names).toEqual(names(batch).slice(0, -tailCount))

		// The session's `ended` row is issued after the trace flush and still gets keepalive.
		void postToIngest("https://ingest.test/v1/sessionReplays/meta", {}, "x".repeat(8 * KIB), true)
		expect(sent.at(-1)?.keepalive).toBe(true)
		const keepaliveBytes = sent
			.filter((request) => request.keepalive)
			.reduce((sum, request) => sum + request.bytes, 0)
		expect(keepaliveBytes).toBeLessThanOrEqual(48 * KIB)
	})

	it("splits while the document is hidden, and keeps a batch that fits in one request", () => {
		vi.stubGlobal("document", { visibilityState: "hidden" })
		const exporter = newestFirstOnExit(otlp(), JsonTraceSerializer)
		exportBatch(exporter, spans(60, KIB))
		expect(sent.map((request) => request.keepalive)).toEqual([true, false])

		sent.length = 0
		exportBatch(exporter, spans(3))
		expect(sent.map((request) => request.names)).toEqual([["s0", "s1", "s2"]])
	})

	it("sends a single span larger than the tail limit on its own", () => {
		const exporter = newestFirstOnExit(otlp(), JsonTraceSerializer)
		flushUnloading(() => exportBatch(exporter, [...spans(2), ...spans(1, 20 * KIB)]))
		expect(sent.map((request) => request.names.length)).toEqual([1, 2])
		expect(sent[0]?.bytes).toBeGreaterThan(UNLOAD_TAIL_BYTES)
	})

	it("reports one result for the batch and queues only the part that failed", async () => {
		const stashed: string[][] = []
		attachSpanStash((part) => stashed.push(names(part)))
		answers = [200, 400]
		const batch = spans(60, KIB)
		const exporter = newestFirstOnExit(new OfflineSpanExporter(otlp()), JsonTraceSerializer)
		let results: Array<{ code: number; error?: Error }> = []
		flushUnloading(() => {
			results = exportBatch(exporter, batch)
		})
		await vi.waitFor(() => expect(results).toHaveLength(1))

		expect(results[0]?.code).toBe(1)
		expect(stashed).toEqual([sent[1]?.names])
		expect(sent).toHaveLength(2)
	})
})
