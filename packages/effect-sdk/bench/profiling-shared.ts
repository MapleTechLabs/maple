// The contract between `profiling.ts` and the worker processes it spawns.
import { Schema } from "effect"

export const ProfilingSetting = Schema.Struct({
	window: Schema.Number,
	samplingIntervalMicros: Schema.Number,
	linkSpans: Schema.Boolean,
})
export type ProfilingSetting = typeof ProfilingSetting.Type

export const WorkerConfig = Schema.Struct({
	profiling: Schema.Union([ProfilingSetting, Schema.Literal(false)]),
	endpoint: Schema.String,
	mode: Schema.Literals(["throughput", "latency", "restart"]),
	durationMs: Schema.Number,
	warmupMs: Schema.Number,
	concurrency: Schema.Number,
	spansPerRequest: Schema.Number,
	workPerSpan: Schema.Number,
	/** Requests per second in latency mode. */
	rate: Schema.Number,
	loadFunctions: Schema.Number,
	stallMs: Schema.Number,
})
export type WorkerConfig = typeof WorkerConfig.Type

export const WorkerResult = Schema.Struct({
	completed: Schema.Number,
	wallMs: Schema.Number,
	cpuMicros: Schema.Number,
	latencies: Schema.Struct({
		p50: Schema.Number,
		p99: Schema.Number,
		p999: Schema.Number,
		max: Schema.Number,
	}),
	stalls: Schema.Array(Schema.Struct({ atMs: Schema.Number, ms: Schema.Number })),
	peakRssBytes: Schema.Number,
	/** From the profiler starting to the run ending: warmup, the measured phase and any draining. */
	profiledMs: Schema.Number,
	/** Restart mode: V8's own cost of ending one window and starting the next, per window. */
	restarts: Schema.optionalKey(
		Schema.Array(Schema.Struct({ stopMs: Schema.Number, startMs: Schema.Number, nodes: Schema.Number })),
	),
})
export type WorkerResult = typeof WorkerResult.Type

export class WorkerFailed extends Schema.TaggedError<WorkerFailed>()(
	"@maple-dev/effect-sdk/bench/WorkerFailed",
	{
		message: Schema.String,
		scenario: Schema.String,
		mode: Schema.String,
		exitCode: Schema.NullOr(Schema.Number),
	},
) {}
