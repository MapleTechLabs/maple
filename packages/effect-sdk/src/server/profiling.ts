// Continuous CPU profiling for Node and Bun, with no native addon: the runtime's own sampling
// profiler through `node:inspector`, exported as OTLP profiles every window.
import { Cause, Duration, Effect, Layer, Option, Ref, Schema, Array as Arr, String as Str } from "effect"
import { type Headers, HttpClient, HttpClientRequest } from "effect/http"
import { OtlpResource } from "effect/observability"
import { SPAN_EVENT_CAPACITY, type SpanTimeline } from "../shared/span-timeline.js"
import { encodeCpuProfile } from "./cpu-profile.js"

export interface ProfilingOptions {
	/**
	 * How often a profile is exported. Default 60 seconds, at least 1 second. Each export restarts the profiler,
	 * which pauses the event loop for a few milliseconds to tens of milliseconds on Node (longer
	 * with more loaded code), so a shorter window trades smoothness for fresher profiles.
	 */
	readonly window?: Duration.Input | undefined
	/**
	 * Microseconds between samples. Default 10000 (100 Hz), what most continuous profilers run
	 * at; a shorter interval resolves shorter spans and costs more CPU. At least 100; a value that
	 * is not a positive number uses the default.
	 */
	readonly samplingIntervalMicros?: number | undefined
	/**
	 * Attribute each sample to the span that was running, so a span's own flame graph can be
	 * read. Default `true`. Adds one row per stack per span instead of one per stack.
	 */
	readonly linkSpans?: boolean | undefined
}

export const DEFAULT_PROFILE_WINDOW = Duration.seconds(60)
/** Each window restarts the profiler, which pauses the event loop: never back to back. */
const MIN_PROFILE_WINDOW = Duration.seconds(1)
/** Below this V8 samples so often the profiler itself is the workload. */
const MIN_SAMPLING_INTERVAL_MICROS = 100
/** A collector that accepts the request and never answers must not hold the next window up. */
const EXPORT_TIMEOUT = Duration.seconds(10)
export const DEFAULT_SAMPLING_INTERVAL_MICROS = 10_000
/** An inspector that takes a session and never answers must not hold the app's startup up. */
export const PROFILER_SETUP_TIMEOUT = Duration.seconds(5)
/** How long any one inspector command may go unanswered before it counts as failed. */
export const PROFILER_COMMAND_TIMEOUT = Duration.seconds(5)

/** The OTLP path profiles are exported on until the signal reaches release candidate. */
export const PROFILES_PATH = "/v1development/profiles"

export class ProfilerFailed extends Schema.TaggedError<ProfilerFailed>()(
	"@maple-dev/effect-sdk/ProfilerFailed",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const CpuProfileSchema = Schema.Struct({
	profile: Schema.Struct({
		nodes: Schema.Array(
			Schema.Struct({
				id: Schema.Number,
				callFrame: Schema.Struct({
					functionName: Schema.String,
					url: Schema.String,
					lineNumber: Schema.Number,
				}),
				children: Schema.optionalKey(Schema.Array(Schema.Number)),
			}),
		),
		startTime: Schema.Number,
		samples: Schema.optionalKey(Schema.Array(Schema.Number)),
		timeDeltas: Schema.optionalKey(Schema.Array(Schema.Number)),
	}),
})
const decodeCpuProfile = Schema.decodeUnknownEffect(CpuProfileSchema)

/** Parameters of the commands this sends: only `Profiler.setSamplingInterval` takes one. */
interface InspectorParams {
	readonly interval?: number
}

/** What the inspector answers a command with, undecoded: `Profiler.stop` carries the profile. */
interface InspectorReply {
	readonly profile?: unknown
}

/** The part of `node:inspector`'s `Session` this drives. */
export interface InspectorSession {
	connect(): void
	disconnect(): void
	post(
		method: string,
		params: InspectorParams,
		callback: (error: Error | null, reply?: InspectorReply) => void,
	): void
}

export interface InspectorModule {
	readonly Session: new () => InspectorSession
}

/** The one builtin this module loads, typed so `getBuiltinModule` never surfaces an untyped value. */
export type LoadBuiltin = (id: "node:inspector") => InspectorModule | undefined

const failed = (message: string) => (cause: unknown) => new ProfilerFailed({ message, cause })

/**
 * No static `node:inspector` import: this module shares a dependency graph with builds for
 * runtimes where that specifier breaks. `process.getBuiltinModule` (Node 20.16 and later, Bun)
 * loads it lazily; a runtime without it (Cloudflare Workers) has no loader at all.
 */
const runtimeLoadBuiltin = (): LoadBuiltin | undefined => {
	const loadBuiltin = (globalThis as { process?: { getBuiltinModule?: LoadBuiltin } }).process
		?.getBuiltinModule
	return typeof loadBuiltin === "function" ? loadBuiltin : undefined
}

/** Fails before anything starts on a runtime with no inspector, or one that refuses a session. */
const openSession = (loadBuiltin: LoadBuiltin | undefined) =>
	Effect.gen(function* () {
		const inspector = yield* Effect.try({
			try: () => loadBuiltin?.("node:inspector"),
			catch: failed("could not load node:inspector"),
		})
		if (inspector === undefined) {
			return yield* new ProfilerFailed({
				message: "node:inspector is not available on this runtime",
				cause: undefined,
			})
		}
		return yield* Effect.try({
			try: (): InspectorSession => {
				const session = new inspector.Session()
				session.connect()
				return session
			},
			catch: failed("could not open an inspector session"),
		})
	})

/**
 * One inspector command, failed after `timeoutMs` with no answer. The bound is a timer, not an
 * interruption, so it also holds inside the uninterruptible window rotation: a silent inspector
 * costs a window there, never a shutdown that waits forever.
 */
const post = (session: InspectorSession, method: string, params: InspectorParams, timeoutMs: number) =>
	Effect.callback<InspectorReply | undefined, ProfilerFailed>((resume) => {
		let settled = false
		// @effect-diagnostics-next-line globalTimersInEffect:off -- an Effect sleep would be interrupted, and the rotation that calls this is uninterruptible
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			resume(Effect.fail(failed(`${method} got no answer`)(`no answer within ${timeoutMs} ms`)))
		}, timeoutMs)
		session.post(method, params, (error, reply) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resume(error === null ? Effect.succeed(reply) : Effect.fail(failed(`${method} failed`)(error)))
		})
		// An interrupted wait (a setup timeout, a bounded shutdown) clears the timer, which would
		// otherwise keep the process alive until it fired.
		return Effect.sync(() => {
			settled = true
			clearTimeout(timer)
		})
	})

/** A setup command that fails, rather than waits forever, when the inspector never answers it. */
const withinSetup = <A>(effect: Effect.Effect<A, ProfilerFailed>) =>
	Effect.timeoutOrElse(effect, {
		duration: PROFILER_SETUP_TIMEOUT,
		orElse: () =>
			Effect.fail(
				failed("the inspector did not answer")(
					`no answer within ${Duration.format(PROFILER_SETUP_TIMEOUT)}`,
				),
			),
	})

/** The profile a `Profiler.stop` reply carries: what was sampled since `Profiler.start`. */
const profileOf = (reply: InspectorReply | undefined) =>
	Effect.mapBoth(decodeCpuProfile(reply), {
		onFailure: failed("unexpected CPU profile shape"),
		onSuccess: ({ profile }) => profile,
	})

interface WindowStart {
	readonly startedAtPerfMs: number
	readonly startedAtEpochMs: number
}

/** The status or cause as text: an error object could print the request, headers included. */
const describeFailure = (error: unknown, depth = 0): string => {
	if (!(error instanceof Error)) return String(error)
	return error.cause === undefined || depth >= 2
		? error.message
		: `${error.message}: ${describeFailure(error.cause, depth + 1)}`
}

/** One warning per outage: failures after the first stay at debug until an export succeeds. */
const makeOutageLog = () => {
	let failures = 0
	return {
		failed: (what: string, error: unknown) =>
			Effect.suspend(() => {
				failures += 1
				const line = `[MapleProfiler] ${what}: ${describeFailure(error)}`
				return failures === 1
					? Effect.logWarning(`${line}. Further failures stay quiet until an export succeeds.`)
					: Effect.logDebug(`${line} (${failures} in a row)`)
			}),
		succeeded: Effect.suspend(() => {
			if (failures === 0) return Effect.void
			const attempts = failures === 1 ? "1 failed export" : `${failures} failed exports`
			failures = 0
			return Effect.logInfo(`[MapleProfiler] profile export recovered after ${attempts}`)
		}),
	}
}

const hexPair = Str.padStart(2, "0")

const randomHex = (bytes: number): string =>
	Arr.join(
		Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => hexPair(byte.toString(16))),
		"",
	)

export interface ProfilerLayerOptions {
	readonly baseUrl: string
	readonly resource: Parameters<typeof OtlpResource.fromConfig>[0]
	readonly headers?: Headers.Input | undefined
	readonly profiling: ProfilingOptions
	/** Shared with the tracer when span linking is on. */
	readonly timeline?: SpanTimeline | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
	/** Loads `node:inspector`. Default: the runtime's `process.getBuiltinModule`, when it has one. */
	readonly loadBuiltin?: LoadBuiltin | undefined
	/** How long one inspector command may go unanswered. Default `PROFILER_COMMAND_TIMEOUT`. */
	readonly commandTimeout?: Duration.Input | undefined
}

/**
 * Starts the CPU profiler and exports one profile per window until the layer's scope closes,
 * when the last partial window is sent. Never fails the app: a runtime that cannot profile logs
 * one warning and runs without it, and a failed export is dropped, with one warning per outage.
 */
export const profilerLayer = (
	options: ProfilerLayerOptions,
): Layer.Layer<never, never, HttpClient.HttpClient> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const client = (yield* HttpClient.HttpClient).pipe(
				// Read the body whatever the status: an unread one holds its connection until GC.
				HttpClient.tap((response) => Effect.ignore(response.arrayBuffer)),
				HttpClient.tapError((error) =>
					error.response ? Effect.ignore(error.response.arrayBuffer) : Effect.void,
				),
				HttpClient.filterStatusOk,
				HttpClient.transformResponse(
					Effect.provideService(HttpClient.TracerPropagationEnabled, false),
				),
			)
			const outage = makeOutageLog()
			const resource = yield* OtlpResource.fromConfig(options.resource)
			const window = profileWindowOf(options.profiling.window)
			const samplingIntervalMicros = samplingIntervalOf(options.profiling.samplingIntervalMicros)
			const url = HttpClientRequest.appendUrl(HttpClientRequest.get(options.baseUrl), PROFILES_PATH).url

			const session = yield* openSession(options.loadBuiltin ?? runtimeLoadBuiltin())
			const commandTimeoutMs = Duration.toMillis(
				Option.getOrElse(
					Duration.fromInput(options.commandTimeout ?? PROFILER_COMMAND_TIMEOUT),
					() => PROFILER_COMMAND_TIMEOUT,
				),
			)
			const command = (method: string, params: InspectorParams = {}) =>
				post(session, method, params, commandTimeoutMs)
			let connected = true
			// Disconnecting ends whatever the session started, the profiler included.
			const endSession = Effect.sync(() => {
				if (!connected) return
				connected = false
				session.disconnect()
			})
			yield* Effect.addFinalizer(() => endSession)
			// A failed setup ends the session now, not at shutdown: a `Profiler.start` that ran
			// but never answered would otherwise sample, unrotated, for the app's whole life.
			const setup = <A>(effect: Effect.Effect<A, ProfilerFailed>) =>
				withinSetup(effect).pipe(Effect.onError(() => endSession))
			yield* setup(command("Profiler.enable"))
			yield* setup(command("Profiler.setSamplingInterval", { interval: samplingIntervalMicros }))

			// The profiler stamps `startTime` as it starts, so the clocks are read just before.
			const start = Effect.gen(function* () {
				const started: WindowStart = {
					startedAtPerfMs: performance.now(),
					// @effect-diagnostics-next-line globalDateInEffect:off -- must be the same instant as the performance.now() above
					startedAtEpochMs: Date.now(),
				}
				yield* command("Profiler.start")
				return started
			})

			const send = (body: unknown) =>
				client
					.execute(
						HttpClientRequest.post(url).pipe(
							HttpClientRequest.setHeaders(options.headers ?? {}),
							HttpClientRequest.setHeader("OTLP-Profiles-Development-Version", "1"),
							HttpClientRequest.bodyJsonUnsafe(body),
						),
					)
					.pipe(
						// Around the whole exchange: the client reads the body before it returns.
						Effect.timeoutOrElse({
							duration: EXPORT_TIMEOUT,
							orElse: () =>
								Effect.fail(
									failed("the collector did not answer in time")(
										`no complete response within ${Duration.format(EXPORT_TIMEOUT)}`,
									),
								),
						}),
						// The export is not the app's work: it must not show up as spans of its own.
						Effect.withTracerEnabled(false),
						// A dropped profile is one window of one signal: never worth a retry storm.
						Effect.matchEffect({
							onFailure: (error) => outage.failed("profile export failed", error),
							onSuccess: () => outage.succeeded,
						}),
					)

			/** Stops the profiler and takes the window's span switches: all that must happen before a restart. */
			const stop = (started: WindowStart) =>
				Effect.gen(function* () {
					const stoppedAtPerfMs = performance.now()
					const reply = yield* command("Profiler.stop")
					return { started, stoppedAtPerfMs, reply, spanEvents: options.timeline?.drain() }
				})

			type Stopped = Effect.Success<ReturnType<typeof stop>>

			const encode = (stopped: Stopped) =>
				Effect.map(profileOf(stopped.reply), (profile) =>
					encodeCpuProfile(profile, {
						resource,
						...stopped.started,
						durationMs: stopped.stoppedAtPerfMs - stopped.started.startedAtPerfMs,
						samplingIntervalMicros,
						spanEvents: stopped.spanEvents,
						profileId: randomHex(16),
					}),
				)

			// A window that cannot be read is dropped; the profiler is already on the next one.
			// Samples after a full span log lose their span link: said once at warning level, then at
			// debug for each later window, so a busy service is told without a warning a minute.
			const overflowWarned = yield* Ref.make(false)
			const reportOverflow = (stopped: Stopped) =>
				stopped.spanEvents?.overflowed === true
					? Effect.flatMap(Ref.getAndSet(overflowWarned, true), (warned) =>
							(warned ? Effect.logDebug : Effect.logWarning)(
								`[MapleProfiler] more than ${SPAN_EVENT_CAPACITY} span switches in one window; later samples in it are not linked to spans`,
							),
						)
					: Effect.void
			const exportWindow = (stopped: Stopped) =>
				Effect.gen(function* () {
					yield* reportOverflow(stopped)
					const body = yield* encode(stopped)
					if (body !== undefined) yield* send(body)
				}).pipe(
					// A defect in the encode drops the window too, never the loop.
					Effect.catchCause((cause) =>
						outage.failed("profile window dropped", Cause.squash(cause)),
					),
				)

			options.timeline?.setRecording(true)
			// A profiler that never started leaves nothing recording.
			const first = yield* setup(start).pipe(
				Effect.onError(() => Effect.sync(() => options.timeline?.setRecording(false))),
			)
			const current = yield* Ref.make(first)
			// Off once the loop has died: the profiler is stopped then, with nothing left to export.
			const running = yield* Ref.make(true)

			// Stop, restart at once, and only then decode, encode and send: the gap between two
			// windows is the two inspector calls.
			// The swap is uninterruptible: a shutdown between the restart and the record of it
			// would stamp the last window with the previous one's start.
			const swap = Effect.uninterruptible(
				Effect.gen(function* () {
					const ended = yield* Ref.get(current)
					const stopped = yield* stop(ended)
					const next = yield* start
					yield* Ref.set(current, next)
					return stopped
				}),
			)
			// A failed stop or start (a debugger attach, another session driving the profiler) costs
			// the window, not the feature: stop whatever is left and start afresh. Only a restart
			// that also fails ends the loop.
			const restart = (error: ProfilerFailed) =>
				Effect.uninterruptible(
					Effect.gen(function* () {
						yield* Effect.logWarning(
							"[MapleProfiler] window dropped, restarting the profiler",
							error,
						)
						options.timeline?.drain()
						yield* Effect.ignore(command("Profiler.stop"))
						const next = yield* start
						yield* Ref.set(current, next)
					}),
				)
			const rotate = swap.pipe(
				Effect.matchEffect({
					onFailure: restart,
					onSuccess: (stopped) =>
						// Let the app run before the encode takes its turn.
						Effect.andThen(Effect.yieldNow, exportWindow(stopped)),
				}),
			)

			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					options.timeline?.setRecording(false)
					if (!(yield* Ref.get(running))) return
					const ended = yield* Ref.get(current)
					const stopped = yield* stop(ended)
					yield* exportWindow(stopped)
				}).pipe(
					Effect.timeout(options.shutdownTimeout ?? Duration.seconds(3)),
					Effect.catch((error) => outage.failed("final profile export skipped", error)),
				),
			)

			yield* Effect.sleep(window).pipe(
				Effect.andThen(rotate),
				Effect.forever,
				// A loop that dies must not leave V8 sampling, and holding every sample, until exit.
				// The scope closing interrupts it too: that is shutdown, whose finalizer exports the
				// last window, so an interruption is passed on untouched.
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					(cause) =>
						Effect.gen(function* () {
							options.timeline?.setRecording(false)
							yield* Ref.set(running, false)
							yield* Effect.ignore(command("Profiler.stop"))
							yield* Effect.logWarning("[MapleProfiler] stopped", Cause.squash(cause))
						}),
				),
				Effect.forkScoped,
			)
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					"[MapleProfiler] profiling is off: this runtime has no CPU profiler the SDK can drive",
					error,
				),
			),
		),
	)

/** `window`, or the default when it is not a duration, and never under `MIN_PROFILE_WINDOW`. */
const profileWindowOf = (window: Duration.Input | undefined): Duration.Duration =>
	Duration.max(
		window === undefined
			? DEFAULT_PROFILE_WINDOW
			: Option.getOrElse(Duration.fromInput(window), () => DEFAULT_PROFILE_WINDOW),
		MIN_PROFILE_WINDOW,
	)

/** Whole microseconds, at least `MIN_SAMPLING_INTERVAL_MICROS`; the default when not a positive number. */
const samplingIntervalOf = (micros: number | undefined): number =>
	micros === undefined || !Number.isFinite(micros) || micros <= 0
		? DEFAULT_SAMPLING_INTERVAL_MICROS
		: Math.max(MIN_SAMPLING_INTERVAL_MICROS, Math.round(micros))
