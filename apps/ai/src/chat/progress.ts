/**
 * What a running pass is doing, accumulated from its tool-call events and written as a whole record
 * on a heartbeat: an investigation's row (which replicates with REPLICA IDENTITY FULL, so a write
 * per tool call would ship the entire row up to a hundred times a run) or a review's comment.
 */
import {
	Clock,
	Duration,
	Effect,
	Fiber,
	Option,
	Queue,
	Ref,
	Schedule,
	Schema,
	SchemaGetter,
	Semaphore,
} from "effect"
import {
	INVESTIGATION_PROGRESS_STEPS,
	type InvestigationProgress,
	type InvestigationStep,
} from "@maple/domain/http"

/** `ChatToolCallEvent.input` is `Schema.Unknown` on the wire; this is the one parse into a record. */
export const ToolCallInput = Schema.Record(Schema.String, Schema.Unknown)
export type ToolCallInput = Schema.Schema.Type<typeof ToolCallInput>

const decode = Schema.decodeUnknownOption(ToolCallInput)

/** A tool call's arguments, or an empty record when they are not one. */
export const parseToolInput = (input: unknown): ToolCallInput => Option.getOrElse(decode(input), () => ({}))

/** How long an investigation's step may sit in memory before it is worth a write. */
export const INVESTIGATION_PROGRESS_HEARTBEAT = Duration.seconds(8)

/** Longest one progress write may take before it is given up on. */
export const PROGRESS_WRITE_TIMEOUT = Duration.seconds(15)

/** Longest argument fragment a label will carry. */
const ARG_MAX = 32

/** Input keys worth naming in a label, most specific first. */
const SALIENT_KEYS = [
	"trace_id",
	"fingerprint",
	"issue_id",
	"pattern",
	"query",
	"service_name",
	"service",
	"path",
	"paths",
	"sql",
] as const

const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
const scalarText = (value: typeof Scalar.Type): string => String(value).trim()

/** An argument as one line: a scalar as itself, a list by its first item and a count (`a.ts +2`). */
const ArgText = Schema.Union([Scalar, Schema.NonEmptyArray(Scalar)]).pipe(
	Schema.decodeTo(Schema.NonEmptyString, {
		decode: SchemaGetter.transform((value) => {
			if (typeof value !== "object") return scalarText(value)
			const first = scalarText(value[0])
			return first === "" || value.length === 1 ? first : `${first} +${value.length - 1}`
		}),
		encode: SchemaGetter.forbidden(() => "a step label is never encoded back into arguments"),
	}),
)
const decodeArg = Schema.decodeUnknownOption(ArgText)

const clamp = (value: string): string => {
	const line = value.split("\n")[0]!.trim()
	return line.length > ARG_MAX ? `${line.slice(0, ARG_MAX - 1).trimEnd()}…` : line
}

/** The one argument worth showing, or nothing: a label padded with a time bound reads as detail while carrying none. */
const salientArg = (input: ToolCallInput): string | null =>
	Option.match(Option.firstSomeOf(SALIENT_KEYS.map((key) => decodeArg(input[key]))), {
		onNone: () => null,
		onSome: clamp,
	})

/** Words that stay upper case when a tool name is read as a phrase. */
const ACRONYMS = new Set(["sql", "id", "api", "mcp"])

const word = (raw: string, first: boolean): string =>
	ACRONYMS.has(raw) ? raw.toUpperCase() : first ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : raw

/**
 * A tool call as a line of English, derived from the verb-first snake-case tool name rather than
 * mapped from it: a map over ~47 tools goes stale the first time one is added and nobody notices.
 */
export const stepLabel = (tool: string, input: ToolCallInput): string => {
	const words = tool.split("_").filter((part) => part.length > 0)
	const phrase = words.length === 0 ? tool : words.map((part, index) => word(part, index === 0)).join(" ")
	const arg = salientArg(input)
	return arg === null ? phrase : `${phrase} · ${arg}`
}

/**
 * Arguments a review step may show on its pull request: the files the pull request already shows.
 * Anything else (a grep pattern, a telemetry query) can carry a value read from private source or
 * production data, and the comment may sit on a public repository.
 */
const PUBLIC_REVIEW_ARGS = ["path", "paths"] as const

/** A review step as its pull request comment shows it. */
export const reviewStepLabel = (tool: string, input: ToolCallInput): string =>
	stepLabel(
		tool,
		Object.fromEntries(PUBLIC_REVIEW_ARGS.flatMap((key) => (key in input ? [[key, input[key]]] : []))),
	)

export interface ProgressFeed {
	/** Note a tool call. Synchronous, since the run's event callback is; stamped by the `Clock` service. */
	readonly step: (tool: string, input: ToolCallInput) => void
	/** Write the steps not written yet, if any. */
	readonly flush: Effect.Effect<void>
	/** Write the record now, changed or not. */
	readonly writeNow: Effect.Effect<void>
	/** Stop writing, waiting out a write in flight. Steps still queue, for a `resume`. */
	readonly pause: Effect.Effect<void>
	/** Write again after a `pause`, as when the report it made way for was refused. */
	readonly resume: Effect.Effect<void>
	/** Stop the feed for good, waiting out a write in flight. Safe to call twice. */
	readonly close: Effect.Effect<void>
}

interface ToolCall {
	readonly tool: string
	readonly input: ToolCallInput
	readonly at: number
}

interface FeedState {
	readonly stepCount: number
	readonly steps: ReadonlyArray<InvestigationStep>
	readonly dirty: boolean
}

/**
 * A pass's progress feed. Steps queue as they happen; a child fiber writes the first one at once
 * (making a reader wait a heartbeat for it is the whole complaint) and the rest on the beat. Writes
 * hold one permit and are uninterruptible, so the turn cannot end, or close the feed, mid-write.
 */
export const makeProgressFeed = Effect.fnUntraced(function* (options: {
	readonly label: (tool: string, input: ToolCallInput) => string
	readonly heartbeat: Duration.Input
	/** Write on every beat, not only after new steps, so the record's own time keeps moving. */
	readonly everyBeat: boolean
	readonly write: (record: InvestigationProgress) => Effect.Effect<void>
}) {
	const clock = yield* Clock.Clock
	const calls = yield* Queue.unbounded<ToolCall>()
	const state = yield* Ref.make<FeedState>({ stepCount: 0, steps: [], dirty: false })
	const permit = yield* Semaphore.make(1)
	const open = yield* Ref.make(true)

	const absorb = (batch: ReadonlyArray<ToolCall>) =>
		Ref.update(state, (current) =>
			batch.length === 0
				? current
				: {
						stepCount: current.stepCount + batch.length,
						steps: [
							...current.steps,
							...batch.map((call) => ({
								tool: call.tool,
								label: options.label(call.tool, call.input),
								at: call.at,
							})),
						].slice(-INVESTIGATION_PROGRESS_STEPS),
						dirty: true,
					},
		)

	// The bookkeeping cannot be cut off midway; only the write itself is interruptible, by its
	// timeout, so a hung request cannot hold the permit (and the report behind it) for long.
	const write = (force: boolean) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if (!(yield* Ref.get(open))) return
				yield* Queue.clear(calls).pipe(Effect.flatMap(absorb))
				const current = yield* Ref.get(state)
				if (!current.dirty && !force) return
				yield* Ref.set(state, { ...current, dirty: false })
				const now = yield* Clock.currentTimeMillis
				const written = yield* restore(
					options
						.write({
							stepCount: current.stepCount,
							steps: current.steps,
							// A row's liveness reads its newest step; a beat that writes anyway is itself the news.
							updatedAt: options.everyBeat ? now : (current.steps.at(-1)?.at ?? now),
						})
						.pipe(Effect.timeoutOption(PROGRESS_WRITE_TIMEOUT)),
				)
				if (Option.isSome(written)) return
				// Still unwritten, so the next beat or the final flush retries it.
				yield* Ref.update(state, (latest) => ({ ...latest, dirty: true }))
				yield* Effect.logWarning("Progress write timed out; the next beat retries")
			}).pipe(permit.withPermits(1)),
		)

	const first = Queue.take(calls).pipe(
		Effect.flatMap((call) => absorb([call])),
		Effect.andThen(write(false)),
	)
	const beat = write(options.everyBeat).pipe(Effect.repeat(Schedule.spaced(options.heartbeat)))
	const fiber = yield* Effect.forkChild(
		Effect.all([first, beat], { concurrency: "unbounded", discard: true }),
	)

	// The flag first, so a write still queued for the permit gives way at once; then the permit,
	// so the one write in flight (bounded by its timeout) finishes before anything follows.
	const pause = Ref.set(open, false).pipe(Effect.andThen(permit.withPermits(1)(Effect.void)))

	return {
		step: (tool, input) => {
			Queue.offerUnsafe(calls, { tool, input, at: clock.currentTimeMillisUnsafe() })
		},
		flush: write(false),
		writeNow: write(true),
		pause,
		resume: Ref.set(open, true),
		close: pause.pipe(Effect.andThen(Fiber.interrupt(fiber))),
	} satisfies ProgressFeed
})
