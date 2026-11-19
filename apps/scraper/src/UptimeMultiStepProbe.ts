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
	filledUrlKeepsHost,
	headersProblem,
	interpolateWithin,
	type UptimeMultiStepConfig,
	type UptimeStep,
	UPTIME_MAX_BODY_LENGTH,
	UPTIME_MAX_HEADER_VALUE_LENGTH,
	UPTIME_MAX_URL_LENGTH,
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

/**
 * Every template of a step filled in, or why not as a sentence: a variable with no value, or a
 * part that would pass the size a saved config may have. The sentence never holds a value.
 */
const interpolateStep = (step: UptimeStep, variables: Readonly<Record<string, string>>) => {
	const fill = (template: string, maximum: number, part: string) =>
		Result.mapError(interpolateWithin(template, variables, maximum), (failure) =>
			failure._tag === "missing"
				? `Variable {{${failure.name}}} has no value`
				: `${part} is too long once its variables are filled in`,
		)
	return Result.all({
		url: fill(step.url, UPTIME_MAX_URL_LENGTH, "The URL"),
		headers: Result.all(
			Rec.map(step.headers, (value) => fill(value, UPTIME_MAX_HEADER_VALUE_LENGTH, "A header value")),
		),
		body:
			step.body === undefined
				? Result.succeed(undefined)
				: fill(step.body, UPTIME_MAX_BODY_LENGTH, "The body"),
	})
}

const contentTypeOf = (headers: Readonly<Record<string, string>>): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Rec.findFirst(headers, (_, name) => Str.toLowerCase(name) === "content-type"),
			([, value]) => value,
		),
	)

/**
 * `outcome` with the sent host replaced by "the step's host" in its error, when a variable filled
 * that host: a response may have supplied it, and the error reaches the monitor page and spans.
 */
export const hideFilledHost = (outcome: ProbeOutcome, template: string, sent: string): ProbeOutcome => {
	const host = URL.parse(sent)?.hostname ?? ""
	if (outcome.error === null || host === "" || Str.includes(host)(template)) return outcome
	return { ...outcome, error: Str.replaceAll(host, "the step's host")(outcome.error) }
}

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
					if (Result.isFailure(filled)) return yield* finish(failed(0, "assertion", filled.failure))
					const { url, headers, body } = filled.success
					// Checked here so a refusal names the step and never quotes the filled URL.
					if (!URL.canParse(url))
						return yield* finish(
							failed(0, "assertion", "The URL is not valid once its variables are filled in"),
						)
					// A value read from a response fills the path or query, never the host the step names.
					if (!filledUrlKeepsHost(step.url, url))
						return yield* finish(
							failed(
								0,
								"assertion",
								"The filled URL requests a different host than the step's URL names",
							),
						)
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
					if (!outcome.ok || observation === null)
						return yield* finish(hideFilledHost(outcome, step.url, url))
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
