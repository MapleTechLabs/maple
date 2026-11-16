// One benchmark run in its own process, so each scenario starts with a cold profiler, JIT and heap.
// Spawned by `profiling.ts`; prints one `RESULT {json}` line.
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Array as Arr, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { Maple } from "../dist/server/index.mjs"
import { type ProfilingSetting, WorkerConfig, type WorkerResult } from "./profiling-shared.ts"

interface InspectorParams {
	readonly interval?: number
}
interface InspectorReply {
	readonly profile?: { readonly nodes: ReadonlyArray<unknown> }
}
interface InspectorSession {
	connect(): void
	post(
		method: string,
		params: InspectorParams,
		callback: (error: Error | null, reply?: InspectorReply) => void,
	): void
}

const config = Schema.decodeSync(Schema.fromJsonString(WorkerConfig))(process.argv[2] ?? "")

// Named, distinct functions so a flame graph has real stacks to show.
const hashStep = (seed: number, rounds: number): number => {
	let h = seed | 0
	for (let i = 0; i < rounds; i++) h = Math.imul(h ^ (h >>> 15), 2246822507) + i
	return h
}
const renderStep = (seed: number): string => JSON.stringify({ seed, items: [seed, seed * 2, seed * 3] })
const scanStep = (text: string): number => text.split(",").length
const spanWork = (seed: number): number => scanStep(renderStep(hashStep(seed, config.workPerSpan)))

/**
 * Imports a generated module of `count` distinct functions and calls each once, standing in for a
 * large app: V8 reports every compiled function to a profiler that starts.
 */
const loadCode = (count: number) =>
	Effect.suspend(() => {
		if (count === 0) return Effect.void
		const file = join(tmpdir(), `maple-profiling-bench-${count}.mjs`)
		const functions = Arr.makeBy(count, (i) => `function f${i}(x){return (x*${i + 1})^${i}}`)
		const calls = Arr.makeBy(count, (i) => `s+=f${i}(${i});`)
		// The module calls each function as it loads, so every one is compiled.
		writeFileSync(
			file,
			`${Arr.join(functions, "\n")}\nlet s=0;${Arr.join(calls, "")}\nexport const sum=s\n`,
		)
		return Effect.asVoid(Effect.promise(() => import(pathToFileURL(file).href)))
	})

const STEP_NAMES = ["db.query", "cache.get", "render", "serialize", "auth.check"]

const request = Effect.forEach(
	Arr.range(1, config.spansPerRequest),
	(i) =>
		Effect.sync(() => spanWork(i)).pipe(
			// Lets other fibers in between, so spans interleave as they do in a real server.
			Effect.andThen(Effect.yieldNow),
			Effect.withSpan(STEP_NAMES[i % STEP_NAMES.length] ?? "step"),
		),
	{ discard: true },
).pipe(Effect.withSpan("request"))

const percentile = (sorted: ReadonlyArray<number>, p: number): number =>
	sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0

/** A 1 ms timer chain: any turn the event loop could not take shows up as lag past 1 ms. */
const makeLagSampler = (stallMs: number) => {
	const stalls: Array<{ atMs: number; ms: number }> = []
	let peakRss = process.memoryUsage().rss
	let last = performance.now()
	let origin = last
	let timer: ReturnType<typeof setTimeout> | undefined
	const tick = () => {
		const now = performance.now()
		const lag = now - last - 1
		if (lag >= stallMs) stalls.push({ atMs: Math.round(now - origin), ms: Math.round(lag * 10) / 10 })
		peakRss = Math.max(peakRss, process.memoryUsage.rss())
		last = now
		timer = setTimeout(tick, 1)
	}
	return {
		start: () => {
			origin = performance.now()
			last = origin
			timer = setTimeout(tick, 1)
		},
		stop: () => {
			clearTimeout(timer)
			return { stalls, peakRss }
		},
	}
}

const timed = (latencies: Array<number>, startedAt: number) =>
	request.pipe(Effect.andThen(Effect.sync(() => latencies.push(performance.now() - startedAt))))

/** Closed loop: every worker runs requests back to back until the deadline. */
const closedLoop = (durationMs: number, latencies: Array<number>) =>
	Effect.suspend(() => {
		const deadline = performance.now() + durationMs
		return Effect.forEach(
			Arr.range(1, config.concurrency),
			() =>
				Effect.whileLoop({
					while: () => performance.now() < deadline,
					body: () => Effect.suspend(() => timed(latencies, performance.now())),
					step: () => undefined,
				}),
			{ concurrency: "unbounded", discard: true },
		)
	})

/**
 * Open loop at a fixed rate. Latency counts from when a request was due, not when it started, so
 * a stall delays every request queued behind it instead of hiding them (no coordinated omission).
 */
const openLoop = (durationMs: number, latencies: Array<number>) =>
	Effect.gen(function* () {
		const intervalMs = 1000 / config.rate
		const total = Math.floor((durationMs / 1000) * config.rate)
		const start = performance.now()
		const fibers: Array<Fiber.Fiber<void>> = []
		yield* Effect.whileLoop({
			while: () => fibers.length < total,
			body: () =>
				Effect.sleep(Duration.millis(1)).pipe(
					Effect.andThen(() => {
						const due = Math.min(total, Math.floor((performance.now() - start) / intervalMs) + 1)
						// `Arr.range(a, b)` with b < a is `[a]`, not empty.
						if (due <= fibers.length) return Effect.succeed([])
						return Effect.forEach(
							Arr.range(fibers.length, due - 1),
							(k) => Effect.forkChild(timed(latencies, start + k * intervalMs)),
							{ discard: false },
						)
					}),
				),
			step: (forked) => {
				fibers.push(...forked)
			},
		})
		yield* Fiber.joinAll(fibers)
	})

/**
 * Drives `node:inspector` directly, under the same load and window as the SDK, and times
 * `Profiler.stop` and `Profiler.start`: the part of each window's stall that V8 owns. The rest of
 * the stall the SDK runs see is its own decode, encode and send on the main thread.
 */
const restartProbe = (setting: ProfilingSetting) =>
	Effect.gen(function* () {
		const inspector: { Session: new () => InspectorSession } = process.getBuiltinModule("node:inspector")
		const session = new inspector.Session()
		session.connect()
		const post = (method: string, params: InspectorParams = {}) =>
			Effect.callback<InspectorReply | undefined, Error>((resume) =>
				session.post(method, params, (error, reply) =>
					resume(error === null ? Effect.succeed(reply) : Effect.fail(error)),
				),
			)
		const timedPost = (method: string) =>
			Effect.suspend(() => {
				const startedAt = performance.now()
				return Effect.map(post(method), (reply) => ({ reply, ms: performance.now() - startedAt }))
			})
		yield* post("Profiler.enable")
		yield* post("Profiler.setSamplingInterval", { interval: setting.samplingIntervalMicros })
		yield* post("Profiler.start")
		const windows = Math.max(1, Math.floor(config.durationMs / setting.window))
		return yield* Effect.forEach(Arr.range(1, windows), () =>
			Effect.gen(function* () {
				yield* closedLoop(setting.window, [])
				const stop = yield* timedPost("Profiler.stop")
				const start = yield* timedPost("Profiler.start")
				const round = (ms: number) => Math.round(ms * 10) / 10
				return {
					stopMs: round(stop.ms),
					startMs: round(start.ms),
					nodes: stop.reply?.profile?.nodes.length ?? 0,
				}
			}),
		)
	})

const program = Effect.gen(function* () {
	// The layer, and so the profiler, is up before this runs.
	const profilingFrom = performance.now()
	yield* loadCode(config.loadFunctions)
	if (config.mode === "restart" && config.profiling !== false) {
		yield* closedLoop(config.warmupMs, [])
		const restarts = yield* restartProbe(config.profiling)
		const result: WorkerResult = {
			completed: 0,
			wallMs: 0,
			cpuMicros: 0,
			latencies: { p50: 0, p99: 0, p999: 0, max: 0 },
			stalls: [],
			peakRssBytes: 0,
			profiledMs: 0,
			restarts,
		}
		return result
	}
	const run = config.mode === "throughput" ? closedLoop : openLoop
	yield* run(config.warmupMs, [])

	const latencies: Array<number> = []
	const sampler = makeLagSampler(config.stallMs)
	const cpuBefore = process.cpuUsage()
	const wallBefore = performance.now()
	sampler.start()
	yield* run(config.durationMs, latencies)
	const { stalls, peakRss } = sampler.stop()
	const cpu = process.cpuUsage(cpuBefore)
	// Both clocks stop before the result is summarized.
	const wallMs = performance.now() - wallBefore
	const sorted = latencies.sort((a, b) => a - b)
	const round = (ms: number) => Math.round(ms * 100) / 100
	const result: WorkerResult = {
		completed: latencies.length,
		wallMs,
		cpuMicros: cpu.user + cpu.system,
		latencies: {
			p50: round(percentile(sorted, 0.5)),
			p99: round(percentile(sorted, 0.99)),
			p999: round(percentile(sorted, 0.999)),
			max: round(sorted[sorted.length - 1] ?? 0),
		},
		stalls,
		peakRssBytes: peakRss,
		profiledMs: performance.now() - profilingFrom,
	}
	return result
})

const MapleLive = Maple.layer({
	serviceName: "profiling-bench",
	endpoint: config.endpoint,
	shutdownTimeout: "10 seconds",
	// Restart mode drives the inspector itself, so the SDK's profiler stays off.
	profiling:
		config.profiling === false || config.mode === "restart"
			? false
			: {
					window: Duration.millis(config.profiling.window),
					samplingIntervalMicros: config.profiling.samplingIntervalMicros,
					linkSpans: config.profiling.linkSpans,
				},
})

// The result is printed after the layer closes, so the last profile window is already exported.
Effect.runPromise(program.pipe(Effect.provide(Layer.fresh(MapleLive)))).then(
	(result) => process.stdout.write(`RESULT ${JSON.stringify(result)}\n`),
	(error: unknown) => {
		process.stderr.write(`worker failed: ${String(error)}\n`)
		process.exitCode = 1
	},
)
