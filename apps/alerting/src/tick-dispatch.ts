/**
 * Cloudflare places only fetch handlers, so a cron fire runs wherever the cron fires, far from
 * the database and the warehouse. The fire hands its tick to this Worker's own fetch handler
 * over a self service binding instead, and that invocation is placed.
 */
import { internalTokenFor, selfFetcher } from "@maple/backend/platform/self-binding"
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { isLaneOf, type TickLane } from "./schedule.ts"

/** The service binding to this Worker itself, declared in the Worker's props. */
export const SELF_BINDING = "ALERTING_SELF"
export const TICK_PATH = "/internal/tick"
// The binding routes by name; the origin is the formality `Request` insists on.
const TICK_URL = `https://maple-alerting.internal${TICK_PATH}`

export class TickDispatchError extends Schema.TaggedError<TickDispatchError>()(
	"@maple/alerting/errors/TickDispatchError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		/** Cloudflare's id for the placed invocation, to find it in the Worker's own logs. */
		ray: Schema.optionalKey(Schema.String),
		/** The start of the answer's body: a runtime error page names what killed the invocation. */
		body: Schema.optionalKey(Schema.String),
		/** What the thrown fetch said, for a hop that never answered. */
		failure: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** Enough of a failed answer's body to name the failure, not enough to flood a log line. */
const MAX_FAILURE_BODY_CHARS = 300

/** The rejected fetch's own words: the client error's message is only its fixed transport text. */
const thrownMessage = (error: HttpClientError.HttpClientError): string =>
	error.cause instanceof Error
		? error.cause.message
		: error.cause === undefined
			? error.message
			: String(error.cause)

/** The tick did not run in the placed handler, so the caller runs it inline. */
export class TickDispatchUnavailable extends Schema.TaggedError<TickDispatchUnavailable>()(
	"@maple/alerting/errors/TickDispatchUnavailable",
	{
		message: Schema.String,
		reason: Schema.Literals(["no-binding", "no-token", "refused-401", "refused-404"]),
	},
) {}

/** A request to the tick route that the handler refuses, with the status it answers. */
export class TickRequestRefused extends Schema.TaggedError<TickRequestRefused>()(
	"@maple/alerting/errors/TickRequestRefused",
	{
		message: Schema.String,
		status: Schema.Literals([400, 401, 404]),
	},
) {}

/**
 * Runs one lane of `cron` in the placed fetch handler. Fails with `TickDispatchUnavailable` when it
 * did not run there (no binding, no token, or the handler refused it), so the caller runs it inline.
 */
export const dispatchTick = Effect.fn("alerting.dispatch_tick")(function* (
	cron: string,
	lane: string,
	env: Record<string, unknown>,
) {
	yield* Effect.annotateCurrentSpan("maple.alerting.lane", lane)
	const binding = selfFetcher(env, SELF_BINDING)
	const token = yield* internalTokenFor(env)
	if (Option.isNone(binding)) {
		return yield* new TickDispatchUnavailable({
			message: "No self service binding",
			reason: "no-binding",
		})
	}
	if (Option.isNone(token)) {
		return yield* new TickDispatchUnavailable({
			message: "No internal service token",
			reason: "no-token",
		})
	}

	const client = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value))
	const request = HttpClientRequest.post(TICK_URL).pipe(
		HttpClientRequest.setUrlParam("cron", cron),
		HttpClientRequest.setUrlParam("lane", lane),
		HttpClientRequest.bearerToken(token.value),
	)
	const response = yield* HttpClient.execute(request).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
		// A callee the runtime killed usually surfaces here, as a thrown fetch, not as an answer.
		Effect.mapError(
			(cause) =>
				new TickDispatchError({
					message: "Placed tick request failed",
					failure: thrownMessage(cause),
					cause,
				}),
		),
		Effect.tapError((error) =>
			Effect.annotateCurrentSpan("maple.alerting.tick_failure", error.failure ?? error.message),
		),
	)
	if (response.status === 204) return
	// The handler did not run the tick: a token mismatch or a version without the route.
	if (response.status === 401 || response.status === 404) {
		return yield* new TickDispatchUnavailable({
			message: `Placed tick refused with ${response.status}`,
			reason: response.status === 401 ? "refused-401" : "refused-404",
		})
	}
	// The placed handler leaves no telemetry when the runtime kills it; its answer is all there is.
	// On the span, not in the message, so the error keeps one fingerprint.
	const ray = response.headers["cf-ray"]
	// Reads only until the cap: an error page can be large, and every failed lane holds one at once.
	const body = yield* response.stream.pipe(
		Stream.decodeText(),
		Stream.scan(
			() => "",
			(head: string, text: string) => head + text,
		),
		Stream.takeUntil((head) => head.length >= MAX_FAILURE_BODY_CHARS),
		Stream.runLast,
		Effect.map((head) =>
			Option.getOrElse(head, () => "")
				.trim()
				.slice(0, MAX_FAILURE_BODY_CHARS),
		),
		Effect.orElseSucceed(() => ""),
	)
	yield* Effect.annotateCurrentSpan({
		"http.response.status_code": response.status,
		...(ray === undefined ? undefined : { "maple.alerting.tick_ray": ray }),
		...(body === "" ? undefined : { "maple.alerting.tick_body": body }),
	})
	return yield* new TickDispatchError({
		message: `Placed tick answered ${response.status}`,
		status: response.status,
		...(ray === undefined ? undefined : { ray }),
		...(body === "" ? undefined : { body }),
	})
})

export interface PlacedTick {
	readonly cron: string
	readonly lane: TickLane
}

/** Validates a request to the tick route against `env`'s internal token and the schedule. */
export const authorizeTickRequest = Effect.fnUntraced(function* (
	request: Request,
	env: Record<string, unknown>,
) {
	const url = new URL(request.url)
	if (request.method !== "POST" || url.pathname !== TICK_PATH) {
		return yield* new TickRequestRefused({ message: "Not the tick route", status: 404 })
	}
	const authorized = Option.match(yield* internalTokenFor(env), {
		onNone: () => false,
		onSome: (expected) =>
			isValidInternalBearer(request.headers.get("authorization") ?? undefined, expected),
	})
	if (!authorized) {
		return yield* new TickRequestRefused({ message: "Missing or invalid internal bearer", status: 401 })
	}
	const cron = url.searchParams.get("cron")
	const lane = url.searchParams.get("lane")
	if (cron === null || lane === null || !isLaneOf(cron, lane)) {
		return yield* new TickRequestRefused({ message: "Unknown cron or lane", status: 400 })
	}
	return { cron, lane } satisfies PlacedTick
})
