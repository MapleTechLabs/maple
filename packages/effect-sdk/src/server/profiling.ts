// Continuous CPU profiling for Node and Bun, with no native addon: the runtime's own sampling
// profiler through `node:inspector`, exported as OTLP profiles every window.
import { Duration, Effect, Layer, Ref, Schema, Array as Arr, String as Str } from "effect"
import { type Headers, HttpClient, HttpClientRequest } from "effect/http"
import { OtlpResource } from "effect/observability"
import type { SpanTimeline } from "../shared/span-timeline.js"
import { encodeCpuProfile } from "./cpu-profile.js"

export interface ProfilingOptions {
	/**
	 * How often a profile is exported. Default 60 seconds. Each export restarts the profiler,
	 * which pauses the event loop for a few milliseconds to tens of milliseconds on Node (longer
	 * with more loaded code), so a shorter window trades smoothness for fresher profiles.
	 */
	readonly window?: Duration.Input | undefined
	/**
	 * Microseconds between samples. Default 10000 (100 Hz), what most continuous profilers run
	 * at; a shorter interval resolves shorter spans and costs more CPU.
	 */
	readonly samplingIntervalMicros?: number | undefined
	/**
	 * Attribute each sample to the span that was running, so a span's own flame graph can be
	 * read. Default `true`. Adds one row per stack per span instead of one per stack.
	 */
	readonly linkSpans?: boolean | undefined
}

export const DEFAULT_PROFILE_WINDOW = Duration.seconds(60)
/** A collector that accepts the request and never answers must not hold the next window up. */
const EXPORT_TIMEOUT = Duration.seconds(10)
export const DEFAULT_SAMPLING_INTERVAL_MICROS = 10_000

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
interface InspectorSession {
	connect(): void
	disconnect(): void
	post(
		method: string,
		params: InspectorParams,
		callback: (error: Error | null, reply?: InspectorReply) => void,
	): void
}

interface InspectorModule {
	readonly Session: new () => InspectorSession
}

/** The one builtin this module loads, typed so `getBuiltinModule` never surfaces an untyped value. */
type LoadBuiltin = (id: "node:inspector") => InspectorModule | undefined

const failed = (message: string) => (cause: unknown) => new ProfilerFailed({ message, cause })

/**
 * No static `node:inspector` import: this module shares a dependency graph with builds for
 * runtimes where that specifier breaks. `process.getBuiltinModule` (Node 20.16 and later, Bun)
 * loads it lazily; a runtime without it (Cloudflare Workers) fails here, before anything starts.
 */
const openSession = Effect.try({
	try: (): InspectorSession => {
		const loadBuiltin = (globalThis as { process?: { getBuiltinModule?: LoadBuiltin } }).process
			?.getBuiltinModule
		const inspector = typeof loadBuiltin === "function" ? loadBuiltin("node:inspector") : undefined
		if (inspector === undefined) throw new Error("node:inspector is not available on this runtime")
		const session = new inspector.Session()
		session.connect()
		return session
	},
	catch: failed("could not open an inspector session"),
})

const post = (session: InspectorSession, method: string, params: InspectorParams = {}) =>
	Effect.callback<InspectorReply | undefined, ProfilerFailed>((resume) => {
		session.post(method, params, (error, reply) =>
			resume(error === null ? Effect.succeed(reply) : Effect.fail(failed(`${method} failed`)(error))),
		)
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
}

/**
 * Starts the CPU profiler and exports one profile per window until the layer's scope closes,
 * when the last partial window is sent. Never fails the app: a runtime that cannot profile logs
 * one warning and runs without it, and a failed export is dropped.
 */
export const profilerLayer = (
	options: ProfilerLayerOptions,
): Layer.Layer<never, never, HttpClient.HttpClient> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
			const resource = yield* OtlpResource.fromConfig(options.resource)
			const window = options.profiling.window ?? DEFAULT_PROFILE_WINDOW
			const samplingIntervalMicros =
				options.profiling.samplingIntervalMicros ?? DEFAULT_SAMPLING_INTERVAL_MICROS
			const url = HttpClientRequest.appendUrl(HttpClientRequest.get(options.baseUrl), PROFILES_PATH).url

			const session = yield* Effect.acquireRelease(openSession, (opened) =>
				Effect.sync(() => opened.disconnect()),
			)
			yield* post(session, "Profiler.enable")
			yield* post(session, "Profiler.setSamplingInterval", { interval: samplingIntervalMicros })

			// The profiler stamps `startTime` as it starts, so the clocks are read just before.
			const start = Effect.gen(function* () {
				const started: WindowStart = {
					startedAtPerfMs: performance.now(),
					// @effect-diagnostics-next-line globalDateInEffect:off -- must be the same instant as the performance.now() above
					startedAtEpochMs: Date.now(),
				}
				yield* post(session, "Profiler.start")
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
						Effect.asVoid,
						Effect.timeout(EXPORT_TIMEOUT),
						// The export is not the app's work: it must not show up as spans of its own.
						Effect.withTracerEnabled(false),
						// A dropped profile is one window of one signal: never worth a retry storm.
						Effect.catch((error) => Effect.logDebug("[MapleProfiler] export failed", error)),
					)

			/** Stops the profiler and takes the window's span switches: all that must happen before a restart. */
			const stop = (started: WindowStart) =>
				Effect.gen(function* () {
					const stoppedAtPerfMs = performance.now()
					const reply = yield* post(session, "Profiler.stop")
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
			const exportWindow = (stopped: Stopped) =>
				Effect.gen(function* () {
					const body = yield* encode(stopped)
					if (body !== undefined) yield* send(body)
				}).pipe(Effect.catch((error) => Effect.logDebug("[MapleProfiler] window dropped", error)))

			options.timeline?.setRecording(true)
			const first = yield* start
			const current = yield* Ref.make(first)

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
			const rotate = Effect.gen(function* () {
				const stopped = yield* swap
				// Let the app run before the encode takes its turn.
				yield* Effect.yieldNow
				yield* exportWindow(stopped)
			})

			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					options.timeline?.setRecording(false)
					const ended = yield* Ref.get(current)
					const stopped = yield* stop(ended)
					yield* exportWindow(stopped)
				}).pipe(
					Effect.timeout(options.shutdownTimeout ?? Duration.seconds(3)),
					Effect.catch((error) => Effect.logDebug("[MapleProfiler] final export skipped", error)),
				),
			)

			yield* Effect.sleep(window).pipe(
				Effect.andThen(rotate),
				Effect.forever,
				Effect.catch((error) =>
					Effect.logWarning("[MapleProfiler] stopped", error).pipe(
						Effect.andThen(Effect.sync(() => options.timeline?.setRecording(false))),
					),
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
