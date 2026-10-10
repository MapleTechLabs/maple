import { describe, it } from "@effect/vitest"
import { afterEach, expect, it as vitestIt, vi } from "vitest"
import { Effect, Metric, Redacted } from "effect"
import {
	buildResolved,
	fetchTransport,
	makeSerializedFlush,
	runFlush,
	type FlushTransport,
	type SignalState,
} from "./flush-core.js"
import { makeLogBuffer } from "./flushable-logger.js"
import { makeMetricBuffer } from "./flushable-metrics.js"
import { makeSpanBuffer } from "./flushable-tracer.js"

const resolved = buildResolved(
	{
		endpoint: "https://collector.test",
		ingestKey: Redacted.make("test-key"),
		resource: { serviceName: "test", serviceVersion: undefined, attributes: {} },
	},
	{ userAgent: "test", keyless: "disable" },
)

const recordSpan = (spans: ReturnType<typeof makeSpanBuffer>, name: string) =>
	Effect.succeed(undefined).pipe(Effect.withSpan(name), Effect.provide(spans.tracerLayer))

const recordLog = (logs: ReturnType<typeof makeLogBuffer>, message: string) =>
	Effect.logInfo(message).pipe(Effect.provide(logs.loggerLayer))

describe("buildResolved", () => {
	vitestIt("stamps the SDK identity on a header browsers allow, alongside user-agent", () => {
		// A page cannot set `user-agent`; ingest reads `x-maple-sdk` as `maple.sdk`.
		expect(resolved.headers["user-agent"]).toBe("test")
		expect(resolved.headers["x-maple-sdk"]).toBe("test")
		expect(resolved.headers.authorization).toBe("Bearer test-key")
	})

	vitestIt("applies each preset's keyless policy: disable, or send without Authorization", () => {
		const keyless = {
			endpoint: "https://proxy.test",
			ingestKey: undefined,
			resource: { serviceName: "test", serviceVersion: undefined, attributes: {} },
		}
		expect(buildResolved(keyless, { userAgent: "test", keyless: "disable" }).noOp).toBe(true)
		const sent = buildResolved(keyless, { userAgent: "test", keyless: "send" })
		expect(sent.noOp).toBe(false)
		expect(sent.headers).not.toHaveProperty("authorization")
	})
})

describe("runFlush", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it.live("retains failed and cooldown batches while allowing the other signal to succeed", () =>
		Effect.gen(function* () {
			vi.useFakeTimers()
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
			const spans = makeSpanBuffer()
			const logs = makeLogBuffer()
			const metrics = makeMetricBuffer()
			const tracesState: SignalState = { disabledUntil: 0 }
			const logsState: SignalState = { disabledUntil: 0 }
			const metricsState: SignalState = { disabledUntil: 0 }
			const traceBodies: unknown[] = []
			const logBodies: unknown[] = []
			let failTraces = true
			const transport: FlushTransport = {
				post: async (url, _headers, body) => {
					if (url.endsWith("/v1/traces")) {
						if (failTraces) throw new Error("collector unavailable")
						traceBodies.push(body)
					} else if (url.endsWith("/v1/logs")) {
						logBodies.push(body)
					}
				},
			}
			const flush = () =>
				runFlush({
					resolved,
					spans,
					logs,
					metrics,
					tracesState,
					logsState,
					metricsState,
					transport,
					logPrefix: "[test]",
					onNoOp: () => undefined,
				})

			yield* recordSpan(spans, "first")
			yield* recordLog(logs, "first-log")
			yield* Effect.promise(flush)
			expect(spans.size()).toBe(1)
			expect(logs.size()).toBe(0)
			expect(logBodies).toHaveLength(1)

			yield* recordSpan(spans, "second")
			yield* Effect.promise(flush)
			expect(spans.size()).toBe(2)
			expect(traceBodies).toHaveLength(0)

			failTraces = false
			vi.advanceTimersByTime(60_000)
			yield* Effect.promise(flush)
			expect(spans.size()).toBe(0)
			expect(traceBodies).toHaveLength(1)
			const body = traceBodies[0] as {
				resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
			}
			expect(body.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => span.name)).toEqual([
				"first",
				"second",
			])
		}),
	)

	vitestIt("aborts a default-transport POST that never answers after 10s and keeps its batch", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const signals: Array<AbortSignal | null | undefined> = []
		const original = globalThis.fetch
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init?.signal)
			// Ignores the abort, like a request whose owner was cancelled.
			return new Promise<Response>(() => {})
		}) as typeof fetch
		const spans = makeSpanBuffer()
		await Effect.runPromise(recordSpan(spans, "slow"))
		vi.useFakeTimers()
		const tracesState: SignalState = { disabledUntil: 0 }
		let settled = false
		const flushed = runFlush({
			resolved,
			spans,
			logs: makeLogBuffer(),
			metrics: makeMetricBuffer(),
			tracesState,
			logsState: { disabledUntil: 0 },
			metricsState: { disabledUntil: 0 },
			transport: fetchTransport,
			logPrefix: "[test]",
		}).then(() => {
			settled = true
		})

		await vi.advanceTimersByTimeAsync(9_999)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await flushed
		globalThis.fetch = original
		errorSpy.mockRestore()
		expect(signals.map((signal) => signal?.aborted)).toEqual([true])
		expect(spans.size()).toBe(1)
		expect(tracesState.disabledUntil).toBeGreaterThan(Date.now())
	})

	vitestIt("serializes overlapping flush calls", async () => {
		let active = 0
		let peak = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const run = makeSerializedFlush(async () => {
			active += 1
			peak = Math.max(peak, active)
			await gate
			active -= 1
		})

		const first = run()
		const second = run()
		await Promise.resolve()
		expect(peak).toBe(1)
		release?.()
		await Promise.all([first, second])
		expect(peak).toBe(1)
	})

	vitestIt("recovers after a rejected drain", async () => {
		const seen: number[] = []
		const run = makeSerializedFlush(async (value: number) => {
			seen.push(value)
			if (value === 1) throw new Error("fixture failure")
		})
		const first = run(1)
		const second = run(2)
		await expect(first).rejects.toThrow("fixture failure")
		await second
		await run(3)
		expect(seen).toEqual([1, 2, 3])
	})

	vitestIt("starts the next drain when the one before it never settles", async () => {
		vi.useFakeTimers()
		const seen: number[] = []
		const run = makeSerializedFlush(async (value: number) => {
			seen.push(value)
			if (value === 1) await new Promise<never>(() => {})
		})
		void run(1)
		const second = run(2)
		await vi.advanceTimersByTimeAsync(14_999)
		expect(seen).toEqual([1])
		await vi.advanceTimersByTimeAsync(1)
		await second
		expect(seen).toEqual([1, 2])
	})

	it.live("sends the newest items first and restores both failed requests once, in drain order", () =>
		Effect.gen(function* () {
			const spans = makeSpanBuffer()
			yield* Effect.forEach(["a", "b", "c", "d"], (name) => recordSpan(spans, name), { discard: true })
			const tracesState: SignalState = { disabledUntil: 0 }
			const sent: Array<Array<string>> = []
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const flush = (tailBytes: number) =>
				runFlush({
					resolved,
					spans,
					logs: makeLogBuffer(),
					metrics: makeMetricBuffer(),
					tracesState,
					logsState: { disabledUntil: 0 },
					metricsState: { disabledUntil: 0 },
					transport: {
						post: async (_url, _headers, body) => {
							const { resourceSpans } = body as {
								resourceSpans: Array<{
									scopeSpans: Array<{ spans: Array<{ name: string }> }>
								}>
							}
							sent.push(resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => span.name))
							// The newest request fails last: completion order must not decide the restore order.
							if (sent.length === 1) await new Promise((resolve) => setTimeout(resolve, 5))
							throw new Error("collector unavailable")
						},
					},
					logPrefix: "[test]",
					tailBytes: () => tailBytes,
					ignoreCooldown: true,
				})

			// Room for one span, not for two.
			const flushed = flush(600)
			// Both requests were issued before `runFlush` returned.
			expect(sent).toEqual([["d"], ["a", "b", "c"]])
			yield* recordSpan(spans, "newer")
			yield* Effect.promise(() => flushed)

			expect(errorSpy).toHaveBeenCalledTimes(1)
			expect(tracesState.disabledUntil).toBeGreaterThan(Date.now())

			// No room for even the newest item: one request, in drain order.
			sent.length = 0
			yield* Effect.promise(() => flush(1))
			errorSpy.mockRestore()
			expect(sent).toEqual([["a", "b", "c", "d", "newer"]])
		}),
	)

	it.live("exports Effect metric snapshots as OTLP metrics", () =>
		Effect.gen(function* () {
			const spans = makeSpanBuffer()
			const logs = makeLogBuffer()
			const metrics = makeMetricBuffer()
			const counter = Metric.counter("test.requests_total", {
				description: "Test requests",
				incremental: true,
			})
			yield* Metric.update(counter, 3).pipe(Effect.provide(metrics.layer))

			let metricsBody: unknown
			yield* Effect.promise(() =>
				runFlush({
					resolved,
					spans,
					logs,
					metrics,
					tracesState: { disabledUntil: 0 },
					logsState: { disabledUntil: 0 },
					metricsState: { disabledUntil: 0 },
					transport: {
						post: async (url, _headers, body) => {
							if (url.endsWith("/v1/metrics")) metricsBody = body
						},
					},
					logPrefix: "[test]",
					onNoOp: () => undefined,
				}),
			)

			const body = metricsBody as {
				resourceMetrics: Array<{
					scopeMetrics: Array<{
						metrics: Array<{
							name: string
							sum: { dataPoints: Array<{ asDouble: number }> }
						}>
					}>
				}>
			}
			const exported = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!
			expect(exported.name).toBe("test.requests_total")
			expect(exported.sum.dataPoints[0]!.asDouble).toBe(3)
		}),
	)

	it.live("retries a changed metric after a failed export", () =>
		Effect.gen(function* () {
			vi.useFakeTimers()
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
			const spans = makeSpanBuffer()
			const logs = makeLogBuffer()
			const metrics = makeMetricBuffer()
			const counter = Metric.counter("test.retry_total")
			yield* Metric.update(counter, 1).pipe(Effect.provide(metrics.layer))

			let attempts = 0
			const tracesState: SignalState = { disabledUntil: 0 }
			const logsState: SignalState = { disabledUntil: 0 }
			const metricsState: SignalState = { disabledUntil: 0 }
			const flush = () =>
				runFlush({
					resolved,
					spans,
					logs,
					metrics,
					tracesState,
					logsState,
					metricsState,
					transport: {
						post: async (url) => {
							if (!url.endsWith("/v1/metrics")) return
							attempts += 1
							if (attempts === 1) throw new Error("collector unavailable")
						},
					},
					logPrefix: "[test]",
					onNoOp: () => undefined,
				})

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			yield* Effect.promise(flush)
			yield* Effect.promise(flush)
			vi.advanceTimersByTime(60_000)
			yield* Effect.promise(flush)
			errorSpy.mockRestore()

			expect(attempts).toBe(2)
		}),
	)
})
