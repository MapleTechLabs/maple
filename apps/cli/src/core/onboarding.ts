// The hosted onboarding run a coding agent reports to (`/v2/onboarding/agent_run`), its public
// ingest key, and the region-derived URLs the `maple onboarding` commands print.

import { Duration, Effect, Option, Result, Schedule, Schema, String as Str } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { V2OnboardingAgentRun, V2PublicIngestKey, type V2OnboardingAgentReport } from "@maple/domain/http/v2"
import { encodeJson } from "@maple/local-server/json"
import { errorMessageOf, parseJson } from "./api-request"

/** A request to the onboarding endpoints that got no usable answer. */
export class OnboardingApiError extends Schema.TaggedError<OnboardingApiError>()(
	"@maple/cli/OnboardingApiError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
	},
) {}

export interface HostedTarget {
	readonly apiUrl: string
	readonly token: string
}

const hostOf = (apiUrl: string): Option.Option<URL> => Option.liftThrowable(() => new URL(apiUrl))()

/** A PR preview's API (`api-pr-12.maple.dev`) has its own ingest gateway beside it. */
const PREVIEW_API_HOST = /^api-(pr-\d+)\.maple\.dev$/u

/**
 * The API does not expose the ingest endpoint, so it follows the API's deploy: a PR preview's own
 * gateway, `api.eu.maple.dev` the EU ingest, anything else the US one.
 */
export const ingestEndpointFor = (apiUrl: string): string =>
	Option.match(hostOf(apiUrl), {
		onNone: () => "https://ingest.maple.dev",
		onSome: (url) => {
			const preview = PREVIEW_API_HOST.exec(url.hostname)
			if (preview !== null) return `https://ingest-${preview[1] ?? ""}.maple.dev`
			return Str.endsWith(".eu.maple.dev")(url.hostname)
				? "https://ingest.eu.maple.dev"
				: "https://ingest.maple.dev"
		},
	})

/** The dashboard beside an API host: `api.` / `api-pr-1.` becomes `app.` / `app-pr-1.`. */
export const appUrlFor = (apiUrl: string): string =>
	Option.match(hostOf(apiUrl), {
		onNone: () => "https://app.maple.dev",
		onSome: (url) =>
			/^api[.-]/.test(url.hostname)
				? `${url.protocol}//${Str.replace(/^api/, "app")(url.host)}`
				: "https://app.maple.dev",
	})

export const traceUrlFor = (apiUrl: string, traceId: string): string =>
	`${appUrlFor(apiUrl)}/traces/${encodeURIComponent(traceId)}`

interface Answer {
	readonly status: number
	readonly json: Option.Option<unknown>
}

const send = (
	target: HostedTarget,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Effect.Effect<Answer, OnboardingApiError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const base = HttpClientRequest.make(method)(`${Str.replace(/\/+$/, "")(target.apiUrl)}${path}`).pipe(
			HttpClientRequest.setHeader("accept", "application/json"),
			HttpClientRequest.bearerToken(target.token),
		)
		const request =
			body === undefined ? base : HttpClientRequest.bodyText(base, encodeJson(body), "application/json")
		const response = yield* client
			.execute(request)
			.pipe(
				Effect.mapError(
					() => new OnboardingApiError({ message: `could not reach ${target.apiUrl}` }),
				),
			)
		const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
		return { status: response.status, json: Result.getSuccess(parseJson(text, "the response")) }
	})

const failure = (answer: Answer): OnboardingApiError =>
	new OnboardingApiError({
		status: answer.status,
		message: Option.getOrElse(
			Option.flatMap(answer.json, errorMessageOf),
			() => `Maple API returned HTTP ${answer.status}`,
		),
	})

const decodeRun = Schema.decodeUnknownEffect(V2OnboardingAgentRun)
const decodePublicKey = Schema.decodeUnknownEffect(V2PublicIngestKey)
const unexpectedResponse = () => new OnboardingApiError({ message: "Maple returned an unexpected response" })

const runFrom = (answer: Answer) =>
	Effect.fromOption(answer.json).pipe(Effect.flatMap(decodeRun), Effect.mapError(unexpectedResponse))
const publicKeyFrom = (answer: Answer) =>
	Effect.fromOption(answer.json).pipe(Effect.flatMap(decodePublicKey), Effect.mapError(unexpectedResponse))

const ok = (status: number) => status >= 200 && status < 300

/** The caller's latest run; `None` when they never started one. */
export const fetchRun = (target: HostedTarget) =>
	Effect.gen(function* () {
		const answer = yield* send(target, "GET", "/v2/onboarding/agent_run")
		if (answer.status === 404) return Option.none<V2OnboardingAgentRun>()
		if (!ok(answer.status)) return yield* failure(answer)
		const run = yield* runFrom(answer)
		return Option.some(run)
	})

export type ReportOutcome =
	| { readonly _tag: "reported"; readonly run: V2OnboardingAgentRun }
	| { readonly _tag: "closed" }
	| { readonly _tag: "no_run" }
	| { readonly _tag: "failed"; readonly message: string }

/** Report a stage. Never fails: progress reporting must not break the agent's setup. */
export const reportProgress = (
	target: HostedTarget,
	report: V2OnboardingAgentReport,
): Effect.Effect<ReportOutcome, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const answer = yield* send(target, "POST", "/v2/onboarding/agent_run/status", report)
		if (answer.status === 409) return { _tag: "closed" } as const
		if (answer.status === 404) return { _tag: "no_run" } as const
		if (!ok(answer.status)) return yield* failure(answer)
		const run = yield* runFrom(answer)
		return { _tag: "reported", run } as const
	}).pipe(
		Effect.catchTag("@maple/cli/OnboardingApiError", (error) =>
			Effect.succeed<ReportOutcome>({ _tag: "failed", message: error.message }),
		),
	)

/** The org's public ingest key; the private key is never requested. */
export const fetchPublicIngestKey = (target: HostedTarget) =>
	Effect.gen(function* () {
		const answer = yield* send(target, "GET", "/v2/ingest_keys/public")
		if (!ok(answer.status)) return yield* failure(answer)
		return yield* publicKeyFrom(answer)
	})

/** What `maple onboarding keys` prints: the endpoint and the public key, never the private one. */
export const onboardingKeys = (target: HostedTarget) =>
	Effect.map(fetchPublicIngestKey(target), (key) => ({
		ingest_endpoint: ingestEndpointFor(target.apiUrl),
		public_key: key.public_key,
	}))

/** Run `find` every `interval` until it yields a trace id or `timeout` passes. */
export const waitForTrace = <E, R>(p: {
	readonly find: Effect.Effect<Option.Option<string>, E, R>
	readonly timeout: Duration.Input
	readonly interval: Duration.Input
}): Effect.Effect<Option.Option<string>, E, R> =>
	p.find.pipe(
		Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(p.interval) }),
		Effect.timeoutOption(p.timeout),
		Effect.map(Option.flatten),
	)
