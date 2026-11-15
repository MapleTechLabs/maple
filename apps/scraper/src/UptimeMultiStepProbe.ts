import { randomBytes } from "node:crypto"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Result,
	String as Str,
	Array as Arr,
} from "effect"
import {
	effectiveAssertions,
	extractVariables,
	headersProblem,
	interpolate,
	type UptimeMultiStepConfig,
	type UptimeStep,
	UPTIME_USER_AGENT,
} from "@maple/domain/uptime"
import { UptimeHttpProbe } from "./UptimeHttpProbe"
import {
	type CheckTraceContext,
	failed,
	formatSeconds,
	type ProbeOutcome,
	succeeded,
	traceparentOf,
	type UptimeStepRun,
} from "./UptimeProbe"

export interface UptimeMultiStepProbeApi {
	/**
	 * Runs the steps in order under one time budget, each as its own request through the HTTP
	 * probe's guard with a child span id in its `traceparent`. Variables a step extracts reach the
	 * later ones; the first failing step ends the run and names the check's error.
	 */
	readonly probe: (config: UptimeMultiStepConfig, trace: CheckTraceContext) => Effect.Effect<ProbeOutcome>
}

const newSpanId = Effect.sync(() => randomBytes(8).toString("hex"))

/** Every template of a step filled in, or the first variable it names that has no value. */
const interpolateStep = (step: UptimeStep, variables: Readonly<Record<string, string>>) =>
	Result.all({
		url: interpolate(step.url, variables),
		headers: Result.all(Rec.map(step.headers, (value) => interpolate(value, variables))),
		body: step.body === undefined ? Result.succeed(undefined) : interpolate(step.body, variables),
	})

const contentTypeOf = (headers: Readonly<Record<string, string>>): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Rec.findFirst(headers, (_, name) => Str.toLowerCase(name) === "content-type"),
			([, value]) => value,
		),
	)

interface Progress {
	readonly variables: Readonly<Record<string, string>>
	readonly runs: ReadonlyArray<UptimeStepRun>
	readonly failedAt: number | null
}

export class UptimeMultiStepProbe extends Context.Service<UptimeMultiStepProbe, UptimeMultiStepProbeApi>()(
	"@maple/scraper/UptimeMultiStepProbe",
	{
		make: Effect.gen(function* () {
			const http = yield* UptimeHttpProbe

			const runStep = (
				step: UptimeStep,
				variables: Readonly<Record<string, string>>,
				trace: CheckTraceContext,
				remainingMs: number,
				runTimeoutMs: number,
			) =>
				Effect.gen(function* () {
					const spanId = yield* newSpanId
					const startedAtMs = yield* Clock.currentTimeMillis
					const filled = interpolateStep(step, variables)
					const finish = (outcome: ProbeOutcome, extracted = {}) =>
						Effect.map(Clock.currentTimeMillis, (endedAtMs) => ({
							run: {
								name: step.name,
								method: step.method,
								// The template, never the filled-in URL: it may hold a token a response gave.
								url: step.url,
								spanId,
								startedAtMs,
								endedAtMs,
								outcome,
							},
							extracted,
						}))
					if (Result.isFailure(filled))
						return yield* finish(
							failed(0, "assertion", `Variable {{${filled.failure}}} has no value`),
						)
					const { url, headers, body } = filled.success
					// A value read from a response may hold what no header can carry; the step fails, the run goes on reporting.
					const unsendable = headersProblem(headers)
					if (unsendable !== null) return yield* finish(failed(0, "assertion", unsendable))
					const contentType = contentTypeOf(headers)
					const { outcome, observation } = yield* http.request(
						{
							method: step.method,
							url,
							// Our user-agent first so a configured one wins; the step's own traceparent last.
							headers: {
								"user-agent": UPTIME_USER_AGENT,
								...headers,
								traceparent: traceparentOf({ traceId: trace.traceId, spanId }),
							},
							body:
								body === undefined
									? null
									: { text: body, contentType: contentType ?? "text/plain" },
						},
						{
							assertions: effectiveAssertions(step.assertions),
							readBody: Arr.some(
								step.extract,
								(extraction) => extraction.from._tag === "json_path",
							),
							timeoutMs: remainingMs,
						},
					)
					// A step's time limit is what is left of the run's, so its timeout is the run's.
					if (outcome.errorType === "timeout")
						return yield* finish({
							...outcome,
							error: `The run took longer than ${formatSeconds(runTimeoutMs)}`,
						})
					if (!outcome.ok || observation === null) return yield* finish(outcome)
					const extracted = extractVariables(step.extract, observation)
					return Result.isFailure(extracted)
						? yield* finish(
								failed(
									outcome.durationMs,
									"assertion",
									extracted.failure,
									outcome.statusCode,
								),
							)
						: yield* finish(outcome, extracted.success)
				})

			const probe = (config: UptimeMultiStepConfig, trace: CheckTraceContext) =>
				Effect.gen(function* () {
					const startedAt = yield* Clock.currentTimeMillis
					const deadline = startedAt + config.timeoutMs
					const start: Progress = { variables: {}, runs: [], failedAt: null }
					const progress = yield* Effect.reduce(
						config.steps,
						() => start,
						(acc, step, index) =>
							Effect.gen(function* () {
								if (acc.failedAt !== null) return acc
								const remainingMs = deadline - (yield* Clock.currentTimeMillis)
								if (remainingMs <= 0) {
									const now = yield* Clock.currentTimeMillis
									const run: UptimeStepRun = {
										name: step.name,
										method: step.method,
										url: step.url,
										spanId: yield* newSpanId,
										startedAtMs: now,
										endedAtMs: now,
										outcome: failed(
											0,
											"timeout",
											`The run took longer than ${formatSeconds(config.timeoutMs)}`,
										),
									}
									return { ...acc, runs: [...acc.runs, run], failedAt: index }
								}
								const { run, extracted } = yield* runStep(
									step,
									acc.variables,
									trace,
									remainingMs,
									config.timeoutMs,
								)
								return {
									variables: { ...acc.variables, ...extracted },
									runs: [...acc.runs, run],
									failedAt: run.outcome.ok ? null : index,
								}
							}),
					)
					const durationMs = (yield* Clock.currentTimeMillis) - startedAt
					const last = progress.runs[progress.runs.length - 1]
					const certificate = progress.runs[0]?.outcome.certificate
					const base =
						progress.failedAt === null || last === undefined
							? succeeded(durationMs, last?.outcome.statusCode ?? null)
							: failed(
									durationMs,
									last.outcome.errorType ?? "assertion",
									`Step ${progress.failedAt + 1} (${last.name}): ${last.outcome.error ?? "failed"}`,
									last.outcome.statusCode,
								)
					return {
						...base,
						steps: progress.runs,
						...(certificate === undefined ? undefined : { certificate }),
					} satisfies ProbeOutcome
				})

			return { probe } satisfies UptimeMultiStepProbeApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
