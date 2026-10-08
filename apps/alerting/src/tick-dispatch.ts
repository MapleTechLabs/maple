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

const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function"

/** The internal token as this invocation's env says; unreadable reads as unset. */
export const internalTokenFor = (env: Record<string, unknown>) =>
	Config.option(Config.Redacted("INTERNAL_SERVICE_TOKEN")).pipe(
		Effect.map(Option.map(Redacted.value)),
		Effect.orElseSucceed(() => Option.none<string>()),
		// The invocation's env is the boundary this config belongs to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(workerEnvLayer(env)),
	)

/**
 * Runs `cron`'s tick in the placed fetch handler. `"unavailable"` means it did not run there
 * (no binding, no token, or the handler refused it), so the caller runs it inline.
 */
export const dispatchTick = Effect.fn("alerting.dispatch_tick")(function* (
	cron: string,
	env: Record<string, unknown>,
) {
	const binding = env[SELF_BINDING]
	const token = yield* internalTokenFor(env)
	if (!isFetcher(binding) || Option.isNone(token)) return "unavailable" as const

	const client = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding))
	const request = HttpClientRequest.post(TICK_URL).pipe(
		HttpClientRequest.setUrlParam("cron", cron),
		HttpClientRequest.bearerToken(token.value),
	)
	const response = yield* HttpClient.execute(request).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
		Effect.mapError((cause) => new TickDispatchError({ message: "Placed tick request failed", cause })),
	)
	if (response.status === 204) return "placed" as const
	// The handler did not run the tick: a token mismatch or a version without the route.
	if (response.status === 401 || response.status === 404) return "unavailable" as const
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

/** Why a request to the tick route is refused, as its response status. */
export type TickRefusal = 400 | 401 | 404

/** Validates a request to the tick route against the internal token and the known crons. */
export const authorizeTickRequest = (
	request: Request,
	token: Option.Option<string>,
	crons: ReadonlyArray<string>,
): PlacedTick | TickRefusal => {
	const url = new URL(request.url)
	if (request.method !== "POST" || url.pathname !== TICK_PATH) return 404
	const authorized = Option.match(token, {
		onNone: () => false,
		onSome: (expected) =>
			isValidInternalBearer(request.headers.get("authorization") ?? undefined, expected),
	})
	if (!authorized) return 401
	const cron = url.searchParams.get("cron")
	if (cron === null || !crons.includes(cron)) return 400
	return {
		cron,
		colo: typeof request.cf?.colo === "string" ? request.cf.colo : "unknown",
		placement: request.headers.get("cf-placement") ?? "none",
	}
}
