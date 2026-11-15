import { describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Logger, Predicate, References, Scope, Array as Arr } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { makeSpanTimeline, type SpanTimeline } from "../shared/span-timeline"
import { expect, vi } from "vitest"
import {
	type InspectorModule,
	type InspectorSession,
	PROFILES_PATH,
	type ProfilerLayerOptions,
	profilerLayer,
} from "./profiling.js"

const frame = (functionName: string) => ({ functionName, url: "file:///app/server.js", lineNumber: 3 })

const nodes = [
	{ id: 1, callFrame: frame("(root)"), children: [2, 3] },
	{ id: 2, callFrame: frame("work") },
	{ id: 3, callFrame: frame("(idle)") },
]
const busyProfile = { nodes, startTime: 1000, samples: [2, 2], timeDeltas: [1000, 1000] }
const idleProfile = { ...busyProfile, samples: [3, 3] }

const WINDOW = "5 seconds"
const POSTED = `POST ${PROFILES_PATH}`
const UNAVAILABLE = "node:inspector is not available on this runtime"

const answer = (status: number) => new Response("{}", { status })

interface Sent {
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
	readonly signal: AbortSignal
	readonly response: Response
}

interface LogLine {
	readonly level: string
	readonly message: string
}

/** A fake inspector and collector that record, in one list, the order things happened in. */
const makeHarness = (
	setup: {
		/** One per `Profiler.stop`, then busy profiles. */
		readonly profiles?: ReadonlyArray<unknown>
		/** The collector's answer to the nth request, counted from 1. Default 200. */
		readonly respond?: (attempt: number) => Response
		/** The inspector refuses `Profiler.start`. */
		readonly refuseStart?: boolean
		/** The inspector refuses the nth `Profiler.stop`, counted from 1. */
		readonly refuseStop?: (stop: number) => boolean
		/** The inspector refuses the nth `Profiler.start`, counted from 1. */
		readonly refuseStartAt?: (start: number) => boolean
	} = {},
) => {
	const events: Array<string> = []
	const params: Array<unknown> = []
	let stops = 0
	let starts = 0
	const requests: Array<Sent> = []
	const logs: Array<LogLine> = []
	const profiles = [...(setup.profiles ?? [])]

	class Session implements InspectorSession {
		connect() {
			events.push("connect")
		}
		disconnect() {
			events.push("disconnect")
		}
		post(...[method, sent, callback]: Parameters<InspectorSession["post"]>) {
			events.push(method)
			if (sent !== undefined) params.push(sent)
			if (method === "Profiler.start") {
				starts += 1
				if (setup.refuseStart === true || setup.refuseStartAt?.(starts) === true)
					return callback(new Error("Profiler is already started"), {})
			}
			if (method !== "Profiler.stop") return callback(null, {})
			stops += 1
			if (setup.refuseStop?.(stops) === true) return callback(new Error("Profiler is not started"), {})
			const profile = profiles.shift() ?? busyProfile
			callback(null, {
				// Reading the profile is the first step of decoding it.
				get profile() {
					events.push("profile read")
					return profile
				},
			})
		}
	}

	const client = HttpClient.make((request, url, signal) =>
		Effect.sync(() => {
			const response = setup.respond?.(requests.length + 1) ?? answer(200)
			const body: unknown =
				request.body._tag === "Uint8Array"
					? JSON.parse(new TextDecoder().decode(request.body.body))
					: undefined
			requests.push({ headers: request.headers, body, signal, response })
			events.push(`${request.method} ${url.pathname}`)
			return HttpClientResponse.fromWeb(request, response)
		}),
	)

	const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
		logs.push({ level: logLevel, message: Arr.join(Arr.map(Arr.ensure(message), String), " ") })
	})

	return {
		events,
		/** The params of every inspector command that carried any. */
		params,
		requests,
		logs,
		/** What happened from the first `Profiler.stop` on, repeated reads of one profile as one. */
		sinceFirstStop: () => Arr.dedupeAdjacent(events.slice(events.indexOf("Profiler.stop"))),
		layer: (options: Partial<ProfilerLayerOptions> = {}) =>
			profilerLayer({
				baseUrl: "http://collector.test",
				resource: { serviceName: "checkout" },
				headers: { authorization: "Bearer key" },
				profiling: { window: WINDOW },
				loadBuiltin: (): InspectorModule => ({ Session }),
				...options,
			}).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
		/** Waits for the nth log line: the loop logs an export's outcome, then sleeps again. */
		logged: (count: number) =>
			Effect.promise(() => vi.waitFor(() => expect(logs).toHaveLength(count), { interval: 5 })),
		/** Captures every level, debug included, in place of the default logger. */
		run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.provide(Logger.layer([logger])),
				Effect.provideService(References.MinimumLogLevel, "Debug"),
			),
	}
}

type Harness = ReturnType<typeof makeHarness>

const stopsIn = (harness: Harness) => Arr.filter(harness.events, (event) => event === "Profiler.stop")

const levels = (harness: Harness) => Arr.map(harness.logs, (line) => line.level)

/** The layer builds, says once why profiling is off, and a window later has sent nothing. */
const expectProfilingOff = (harness: Harness, options: Partial<ProfilerLayerOptions>, reason: string) =>
	Effect.gen(function* () {
		yield* Layer.build(harness.layer(options))
		yield* TestClock.adjust(WINDOW)
		expect(levels(harness)).toEqual(["Warn"])
		expect(harness.logs[0]?.message).toContain("profiling is off")
		expect(harness.logs[0]?.message).toContain(reason)
		expect(harness.requests).toEqual([])
		expect(harness.events).not.toContain("Profiler.start")
	}).pipe(harness.run)

/** Hides `process.getBuiltinModule` until the test's scope closes, as on a runtime without it. */
const hideGetBuiltinModule = Effect.acquireRelease(
	Effect.sync(() => {
		// The package has no node types, so `process` is reached as a property of the global.
		const scope: object = globalThis
		const runtime = Predicate.hasProperty(scope, "process") ? scope.process : undefined
		if (!Predicate.isObject(runtime)) return () => {}
		const own = Reflect.getOwnPropertyDescriptor(runtime, "getBuiltinModule")
		Reflect.defineProperty(runtime, "getBuiltinModule", { value: undefined, configurable: true })
		return () => {
			if (own === undefined) Reflect.deleteProperty(runtime, "getBuiltinModule")
			else Reflect.defineProperty(runtime, "getBuiltinModule", own)
		}
	}),
	(restore) => Effect.sync(restore),
)

describe("profilerLayer without an inspector", () => {
	it.effect("runs without profiling when the runtime has no process.getBuiltinModule", () =>
		Effect.gen(function* () {
			yield* hideGetBuiltinModule
			// No injected loader: this is the real lookup.
			yield* expectProfilingOff(makeHarness(), { loadBuiltin: undefined }, UNAVAILABLE)
		}),
	)

	it.effect("runs without profiling when node:inspector does not load", () =>
		expectProfilingOff(makeHarness(), { loadBuiltin: () => undefined }, UNAVAILABLE),
	)

	it.effect("stops recording span switches when the profiler refuses to start", () => {
		const harness = makeHarness({ refuseStart: true })
		const recording: Array<boolean> = []
		const timeline = makeSpanTimeline()
		const watched: SpanTimeline = {
			...timeline,
			setRecording: (next) => {
				recording.push(next)
				timeline.setRecording(next)
			},
		}
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer({ timeline: watched }))
			expect(harness.logs[0]?.message).toContain("profiling is off")
			expect(recording.at(-1)).toBe(false)
		}).pipe(harness.run)
	})

	it.effect("runs without profiling when the inspector refuses a session", () => {
		class Refused implements InspectorSession {
			constructor() {
				throw new Error("Inspector is not available")
			}
			connect() {}
			disconnect() {}
			post() {}
		}
		return expectProfilingOff(
			makeHarness(),
			{ loadBuiltin: () => ({ Session: Refused }) },
			"could not open an inspector session",
		)
	})
})

describe("profilerLayer", () => {
	it.effect("restarts the profiler before a window is decoded, then sends it in one request", () => {
		const harness = makeHarness()
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())
			expect(harness.requests).toEqual([])

			yield* TestClock.adjust(WINDOW)

			expect(harness.sinceFirstStop()).toEqual([
				"Profiler.stop",
				"Profiler.start",
				"profile read",
				POSTED,
			])
			expect(harness.requests).toHaveLength(1)
			const sent = harness.requests[0]
			expect(sent?.headers["otlp-profiles-development-version"]).toBe("1")
			expect(sent?.headers["authorization"]).toBe("Bearer key")
			// The export is not app work: it joins no trace.
			expect(sent?.headers["traceparent"]).toBeUndefined()
			expect(sent?.body).toHaveProperty("resourceProfiles")
			expect(harness.logs).toEqual([])
		}).pipe(harness.run)
	})

	it.effect("reads the response body, so the connection is released", () => {
		const harness = makeHarness({ respond: (attempt) => answer(attempt === 1 ? 200 : 404) })
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())
			yield* TestClock.adjust(WINDOW)
			expect(harness.requests[0]?.response.bodyUsed).toBe(true)

			yield* TestClock.adjust(WINDOW)
			expect(harness.requests[1]?.response.bodyUsed).toBe(true)
		}).pipe(harness.run)
	})

	it.effect("gives up on a collector that sends headers and then never finishes the body", () => {
		const harness = makeHarness({
			respond: (attempt) => (attempt === 1 ? new Response(new ReadableStream()) : answer(200)),
		})
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())
			yield* TestClock.adjust(WINDOW)
			expect(harness.requests).toHaveLength(1)
			expect(harness.logs).toEqual([])

			// The export timeout, which is longer than the window.
			yield* TestClock.adjust("10 seconds")

			expect(levels(harness)).toEqual(["Warn"])
			expect(harness.logs[0]?.message).toContain("did not answer in time")
			expect(harness.requests[0]?.signal.aborted).toBe(true)
		}).pipe(harness.run)
	})

	it.effect("exports the last partial window when the scope closes", () => {
		const harness = makeHarness()
		return Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Layer.buildWithScope(harness.layer(), scope)
			yield* TestClock.adjust("2 seconds")
			expect(harness.requests).toEqual([])

			yield* Scope.close(scope, Exit.void)

			expect(harness.sinceFirstStop()).toEqual(["Profiler.stop", "profile read", POSTED, "disconnect"])
			expect(harness.requests[0]?.response.bodyUsed).toBe(true)
		}).pipe(harness.run)
	})

	it.effect("never restarts the profiler more than once a second or samples at a zero interval", () => {
		const harness = makeHarness()
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer({ profiling: { window: 0, samplingIntervalMicros: 0 } }))
			expect(harness.params).toContainEqual({ interval: 10_000 })

			yield* TestClock.adjust("999 millis")
			expect(harness.events).not.toContain("Profiler.stop")
			yield* TestClock.adjust("1 millis")
			expect(stopsIn(harness)).toHaveLength(1)
		}).pipe(harness.run)
	})

	it.effect("a failed stop costs one window, not the profiler", () => {
		const harness = makeHarness({ refuseStop: (stop) => stop === 1 })
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())
			yield* TestClock.adjust(WINDOW)
			yield* harness.logged(1)
			expect(harness.logs[0]?.message).toContain("restarting the profiler")
			// The refused stop, the restart's stop, then a fresh start.
			expect(stopsIn(harness)).toHaveLength(2)
			expect(harness.events.at(-1)).toBe("Profiler.start")
			expect(harness.requests).toEqual([])

			// The next window is read and sent as usual.
			yield* TestClock.adjust(WINDOW)
			expect(harness.requests).toHaveLength(1)
		}).pipe(harness.run)
	})

	it.effect("stops the profiler when it cannot restart, and exports nothing more at shutdown", () => {
		const harness = makeHarness({
			refuseStop: (stop) => stop === 1,
			refuseStartAt: (start) => start === 2,
		})
		return Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Layer.buildWithScope(harness.layer(), scope)
			yield* TestClock.adjust(WINDOW)
			yield* harness.logged(2)
			expect(harness.logs[1]?.message).toContain("stopped")
			// The swap's stop, the restart's stop, then the loop stopping the profiler itself.
			expect(stopsIn(harness)).toHaveLength(3)

			yield* Scope.close(scope, Exit.void)
			expect(stopsIn(harness)).toHaveLength(3)
			expect(harness.requests).toEqual([])
			expect(harness.logs).toHaveLength(2)
		}).pipe(harness.run)
	})

	it.effect("says once when a window's span log overflowed, then only at debug", () => {
		const harness = makeHarness()
		const timeline = makeSpanTimeline()
		const overflowing: SpanTimeline = {
			...timeline,
			drain: () => ({ ...timeline.drain(), overflowed: true }),
		}
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer({ timeline: overflowing }))
			yield* TestClock.adjust(WINDOW)
			yield* harness.logged(1)
			yield* TestClock.adjust(WINDOW)
			yield* harness.logged(2)
			expect(levels(harness)).toEqual(["Warn", "Debug"])
			expect(harness.logs[0]?.message).toContain("not linked to spans")
			// Overflow costs span links, never the window.
			expect(harness.requests).toHaveLength(2)
		}).pipe(harness.run)
	})

	it.effect("keeps profiling through failed exports, warning once per outage", () => {
		const statuses = [404, 404, 200, 503]
		const harness = makeHarness({ respond: (attempt) => answer(statuses[attempt - 1] ?? 200) })
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())
			yield* Effect.forEach(statuses, (_, index) =>
				Effect.andThen(TestClock.adjust(WINDOW), harness.logged(index + 1)),
			)

			expect(harness.requests).toHaveLength(4)
			expect(levels(harness)).toEqual(["Warn", "Debug", "Info", "Warn"])
			expect(harness.logs[0]?.message).toContain("404")
			expect(harness.logs[1]?.message).toContain("404")
			expect(harness.logs[2]?.message).toContain("recovered after 2 failed exports")
			expect(harness.logs[3]?.message).toContain("503")
		}).pipe(harness.run)
	})

	it.effect("sends nothing for a window that was idle", () => {
		const harness = makeHarness({ profiles: [idleProfile, busyProfile] })
		return Effect.gen(function* () {
			yield* Layer.build(harness.layer())

			yield* TestClock.adjust(WINDOW)
			expect(harness.events).toContain("profile read")
			expect(harness.requests).toEqual([])

			yield* TestClock.adjust(WINDOW)
			expect(harness.requests).toHaveLength(1)
			expect(harness.logs).toEqual([])
		}).pipe(harness.run)
	})
})
