/**
 * Cloudflare places only fetch handlers, so a cron fire runs wherever the cron fires, far from
 * the database and the warehouse. The fire hands its tick to this Worker's own fetch handler
 * over a self service binding instead, and that invocation is placed.
 */
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

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
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

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

const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function"

/** Surfaces a 3xx as the response instead of following it, so the bearer never leaves the hop. */
const withManualRedirects = (binding: Fetcher): Fetcher => ({
	fetch: (input, init) => binding.fetch(input, { ...init, redirect: "manual" }),
	connect: (address, options) => binding.connect(address, options),
})

/** The internal token as this invocation's env says; unreadable reads as unset. */
const internalTokenFor = (env: Record<string, unknown>) =>
	Config.option(Config.Redacted("INTERNAL_SERVICE_TOKEN")).pipe(
		Effect.map(Option.map(Redacted.value)),
		Effect.orElseSucceed(() => Option.none<string>()),
		// The invocation's env is the boundary this config belongs to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(workerEnvLayer(env)),
	)

/**
 * Runs `cron`'s tick in the placed fetch handler. Fails with `TickDispatchUnavailable` when it did
 * not run there (no binding, no token, or the handler refused it), so the caller runs it inline.
 */
export const dispatchTick = Effect.fn("alerting.dispatch_tick")(function* (
	cron: string,
	env: Record<string, unknown>,
) {
	const binding = env[SELF_BINDING]
	const token = yield* internalTokenFor(env)
	if (!isFetcher(binding)) {
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

	const client = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(withManualRedirects(binding)))
	const request = HttpClientRequest.post(TICK_URL).pipe(
		HttpClientRequest.setUrlParam("cron", cron),
		HttpClientRequest.bearerToken(token.value),
	)
	const response = yield* HttpClient.execute(request).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
		Effect.mapError((cause) => new TickDispatchError({ message: "Placed tick request failed", cause })),
	)
	if (response.status === 204) return
	// The handler did not run the tick: a token mismatch or a version without the route.
	if (response.status === 401 || response.status === 404) {
		return yield* new TickDispatchUnavailable({
			message: `Placed tick refused with ${response.status}`,
			reason: response.status === 401 ? "refused-401" : "refused-404",
		})
	}
	return yield* new TickDispatchError({
		message: `Placed tick answered ${response.status}`,
		status: response.status,
	})
})

export interface PlacedTick {
	readonly cron: string
	/** The data center that ran the handler, e.g. `IAD`. */
	readonly colo: string
	/** Cloudflare's `cf-placement` header, e.g. `remote-IAD` or `local-FRA`. */
	readonly placement: string
}

/** Validates a request to the tick route against `env`'s internal token and the known crons. */
export const authorizeTickRequest = Effect.fnUntraced(function* (
	request: Request,
	env: Record<string, unknown>,
	crons: ReadonlyArray<string>,
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
	if (cron === null || !crons.includes(cron)) {
		return yield* new TickRequestRefused({ message: "Unknown cron", status: 400 })
	}
	return {
		cron,
		colo: typeof request.cf?.colo === "string" ? request.cf.colo : "unknown",
		placement: request.headers.get("cf-placement") ?? "none",
	} satisfies PlacedTick
})
