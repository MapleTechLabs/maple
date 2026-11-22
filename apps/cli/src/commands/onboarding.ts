// `maple onboarding`: the commands a coding agent runs while it sets Maple up for a user,
// reporting each stage to the run the dashboard shows. Hosted Maple only.

import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { Array as Arr, Console, Duration, Effect, Option, Predicate, Redacted, String as Str } from "effect"
import { ONBOARDING_AGENT_STAGES } from "@maple/domain/onboarding-agent-run"
import type { V2OnboardingAgentReport } from "@maple/domain/http/v2"
import { MapleConfig } from "../core/config"
import {
	fetchRun,
	ingestEndpointFor,
	onboardingKeys,
	reportProgress,
	traceUrlFor,
	waitForTrace,
	type HostedTarget,
	type ReportOutcome,
} from "../core/onboarding"
import * as Remote from "../core/remote-ops"
import { resolveRangeChecked } from "../core/time"
import { makeV2Client } from "../core/v2-client"
import { CliNotFoundError, CliUsageError } from "../lib/errors"
import { printResult } from "../lib/output"

const REPORTED_STATUSES = ["active", "waiting", "completed", "skipped", "failed"] as const
const VERIFY_WINDOW = "15m"
const VERIFY_INTERVAL = Duration.seconds(5)

/** The logged-in hosted workspace; onboarding runs live there, never on a local server. */
const hostedTarget = Effect.gen(function* () {
	if (Arr.some(process.argv, (arg) => arg === "--local" || /^--local=(?!false$)/.test(arg)))
		return yield* new CliUsageError({
			message: "maple onboarding needs hosted Maple; --local is not supported",
			hint: "drop --local",
		})
	const config = yield* MapleConfig
	const target = Option.all({ apiUrl: config.apiUrl, token: config.token })
	if (Option.isNone(target))
		return yield* new CliUsageError({
			message: "maple onboarding needs hosted Maple, and you are not logged in",
			hint: "run `MAPLE_HANDOFF=<code> maple auth login` with the code from Maple's agent prompt",
		})
	return { apiUrl: target.value.apiUrl, token: Redacted.value(target.value.token) } satisfies HostedTarget
})

const status = Command.make("status", {}).pipe(
	Command.withDescription("Show your latest onboarding run and the status of each stage"),
	Command.withHandler(
		Effect.fnUntraced(function* () {
			const target = yield* hostedTarget
			const run = yield* fetchRun(target)
			if (Option.isNone(run))
				return yield* new CliNotFoundError({
					message: "no onboarding run",
					hint: "copy the agent prompt from Maple's connect step to start one",
				})
			yield* printResult(run.value)
		}),
	),
)

/** One line per outcome. Every outcome exits 0: reporting never fails the agent's setup. */
export const describeReport = (
	outcome: ReportOutcome,
): { readonly line: string; readonly toStderr: boolean } => {
	switch (outcome._tag) {
		case "reported":
			return { line: `reported; run is ${outcome.run.status}`, toStderr: false }
		case "closed":
			return { line: "run is closed; stop reporting", toStderr: false }
		case "no_run":
			return { line: "no onboarding run; nothing to report", toStderr: false }
		case "failed":
			return { line: `warning: could not report progress: ${outcome.message}`, toStderr: true }
	}
}

const printOutcome = (outcome: ReportOutcome) => {
	const { line, toStderr } = describeReport(outcome)
	return toStderr ? Console.error(line) : Console.log(line)
}

const report = Command.make("report", {
	stage: Argument.Literals("stage", ONBOARDING_AGENT_STAGES).pipe(
		Argument.withDescription(`The setup stage: ${Arr.join(ONBOARDING_AGENT_STAGES, ", ")}`),
	),
	status: Argument.Literals("status", REPORTED_STATUSES).pipe(
		Argument.withDescription(`Its status now: ${Arr.join(REPORTED_STATUSES, ", ")}`),
	),
	note: Flag.optional(
		Flag.String("note").pipe(
			Flag.withDescription(
				"A short plain note for the user; never file contents, paths, output or secrets",
			),
		),
	),
	service: Flag.String("service").pipe(
		Flag.withDescription("A service.name you configured, repeatable"),
		Flag.atLeast(0),
	),
	traceId: Flag.optional(
		Flag.String("trace-id").pipe(Flag.withDescription("The verification trace found in Maple")),
	),
	runStatus: Flag.optional(
		Flag.Literals("run-status", ["completed", "failed"]).pipe(
			Flag.withDescription(
				"Close the run: completed after the last stage, failed if setup cannot go on",
			),
		),
	),
}).pipe(
	Command.withDescription("Report an onboarding stage to the run Maple shows the user"),
	Command.withExamples([
		{
			command: 'maple onboarding report instrument_app active --note "Instrumenting 2 services"',
			description: "Mark a stage in progress",
		},
		{
			command: "maple onboarding report prepare_production completed --run-status completed",
			description: "Finish the run",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const target = yield* hostedTarget
			const body: V2OnboardingAgentReport = {
				stage: a.stage,
				status: a.status,
				...(Option.isSome(a.note) ? { note: a.note.value } : undefined),
				...(a.service.length > 0 ? { service_names: a.service } : undefined),
				...(Option.isSome(a.traceId) ? { trace_id: a.traceId.value } : undefined),
				...(Option.isSome(a.runStatus) ? { run_status: a.runStatus.value } : undefined),
			}
			const outcome = yield* reportProgress(target, body)
			yield* printOutcome(outcome)
		}),
	),
)

const keys = Command.make("keys", {}).pipe(
	Command.withDescription("Print the ingest endpoint and the public ingest key for your Maple org"),
	Command.withHandler(
		Effect.fnUntraced(function* () {
			const target = yield* hostedTarget
			const keys = yield* onboardingKeys(target)
			yield* printResult(keys)
		}),
	),
)

export const verifyHints = (apiUrl: string): string =>
	`check that ${Arr.join(
		[
			`the app exports to ${ingestEndpointFor(apiUrl)} (keys are region-specific)`,
			"its key is the one `maple onboarding keys` prints",
			"telemetry starts before the app's other imports",
			"the exporter logs no errors and the service handled a request",
		],
		"; ",
	)}`

/** The newest root trace from `service` in the verification window, if any. */
const latestTrace = (target: HostedTarget, service: string) =>
	Effect.gen(function* () {
		const client = yield* makeV2Client(target.apiUrl, target.token)
		const range = yield* resolveRangeChecked({
			since: VERIFY_WINDOW,
			start: Option.none(),
			end: Option.none(),
		})
		const result = yield* Remote.searchTraces(client, { range, service, limit: 1 })
		return Option.map(Arr.head(result.spans), (span) => Str.toLowerCase(span.traceId))
	}).pipe(
		// Only a transient failure waits for the next tick; a refused key or a bad request never heals.
		Effect.catchIf(isTransientSearchFailure, () => Effect.succeed(Option.none<string>())),
	)

/** Network, 5xx and rate-limit failures; the v2 client wraps them in `WarehouseQueryError`. */
export const isTransientSearchFailure = (error: unknown): boolean => {
	if (!Predicate.isTagged(error, "@maple/http/errors/WarehouseQueryError")) return false
	const cause = Predicate.hasProperty(error, "cause") ? error.cause : undefined
	const causeTag = Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag) ? cause._tag : ""
	return causeTag === "" || TRANSIENT_CAUSE.test(causeTag)
}
const TRANSIENT_CAUSE =
	/HttpClientError|RequestError|TransportError|Unavailable|RateLimit|Timeout|Overloaded|WorkerUnavailable/u

const verify = Command.make("verify", {
	service: Flag.String("service").pipe(
		Flag.withAlias("s"),
		Flag.withDescription("The service.name the app sends as"),
	),
	timeout: Flag.Int("timeout").pipe(
		Flag.withDescription("Seconds to wait for a trace (default: 120)"),
		Flag.withDefault(120),
		Flag.filter(
			(n) => n >= 1,
			() => "a whole number of seconds, at least 1",
		),
	),
}).pipe(
	Command.withDescription(
		`Wait until Maple receives a trace from a service (last ${VERIFY_WINDOW}), then report the verification`,
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const target = yield* hostedTarget
			yield* Console.error(`Waiting up to ${a.timeout}s for a trace from ${a.service}…`)
			const found = yield* waitForTrace({
				find: latestTrace(target, a.service),
				timeout: Duration.seconds(a.timeout),
				interval: VERIFY_INTERVAL,
			})
			if (Option.isNone(found)) {
				const outcome = yield* reportProgress(target, {
					stage: "receive_verification",
					status: "waiting",
					note: "No trace received yet",
				})
				if (outcome._tag === "failed") yield* printOutcome(outcome)
				return yield* new CliNotFoundError({
					message: `no trace from ${a.service} reached Maple in ${a.timeout}s`,
					hint: verifyHints(target.apiUrl),
				})
			}
			const traceId = found.value
			yield* printResult({
				service: a.service,
				trace_id: traceId,
				url: traceUrlFor(target.apiUrl, traceId),
			})
			const outcome = yield* reportProgress(target, {
				stage: "receive_verification",
				status: "completed",
				service_names: [a.service],
				trace_id: traceId,
			})
			if (outcome._tag === "failed") yield* printOutcome(outcome)
		}),
	),
)

export const onboarding = Command.make("onboarding").pipe(
	Command.withDescription(
		"Report a coding agent's Maple setup to the onboarding run Maple shows (hosted Maple only)",
	),
	Command.withSubcommands([status, report, keys, verify]),
)
