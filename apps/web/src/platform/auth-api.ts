import { BrowserKeyValueStore } from "@effect/platform-browser"
import { MapleApi, SelfHostedLoginRequest, UnauthorizedError } from "@maple/domain/http"
import { apiBaseUrl } from "../lib/services/common/api-base-url"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { KeyValueStore } from "effect/persistence"

/** The self-hosted root-password session lives here, per tab. */
const SELF_HOSTED_TOKEN_STORAGE_KEY = "maple.self_hosted.token"
/** Dispatched when the stored token changes outside `update` (a rejected renewal). */
export const SELF_HOSTED_AUTH_EVENT = "maple:self-hosted-auth-changed"

// Each storage call is its own boundary: sessionStorage is per tab and needs no shared scope.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const withSessionStorage = Effect.provide(BrowserKeyValueStore.layerSessionStorage)

export const readSessionToken: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
	const store = yield* KeyValueStore.KeyValueStore
	const token = yield* store.get(SELF_HOSTED_TOKEN_STORAGE_KEY)
	return Option.filter(Option.fromNullishOr(token), (value) => value.length > 0)
}).pipe(withSessionStorage, Effect.orElseSucceed(Option.none))

/** Storage failures are ignored: the session simply does not persist. */
export const saveSessionToken = (token: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const store = yield* KeyValueStore.KeyValueStore
		yield* store.set(SELF_HOSTED_TOKEN_STORAGE_KEY, token)
	}).pipe(withSessionStorage, Effect.ignore)

export const clearSessionToken: Effect.Effect<void> = Effect.gen(function* () {
	const store = yield* KeyValueStore.KeyValueStore
	yield* store.remove(SELF_HOSTED_TOKEN_STORAGE_KEY)
}).pipe(withSessionStorage, Effect.ignore)

export const announceSessionTokenChanged: Effect.Effect<void> = Effect.sync(() =>
	window.dispatchEvent(new Event(SELF_HOSTED_AUTH_EVENT)),
)

/** The session check or renewal could not settle the session. `Rejected` ends it. */
export class SessionCheckError extends Schema.TaggedError<SessionCheckError>()(
	"@maple/web/SessionCheckError",
	{ reason: Schema.Literals(["Rejected", "Unreachable"]), cause: Schema.Defect() },
) {}

const makeClient = (transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
	HttpApiClient.make(MapleApi, { baseUrl: apiBaseUrl, transformClient })

const withBearer = (token: string) => HttpClient.mapRequest(HttpClientRequest.bearerToken(token))

/** Session check: any answer but a transport failure ends the session (`resolveSelfHostedRouterAuth`). */
const classifySessionCheck = (cause: unknown) =>
	new SessionCheckError({
		reason: Predicate.isTagged(cause, "HttpClientError") ? "Unreachable" : "Rejected",
		cause,
	})

/** Renewal: only a 401 ends the session; anything else keeps the current token (`renewSessionToken`). */
const classifyRenewal = (cause: unknown) =>
	new SessionCheckError({ reason: Schema.is(UnauthorizedError)(cause) ? "Rejected" : "Unreachable", cause })

/**
 * The unauthenticated `/api/auth` calls: login, session check, renewal. A plain fetch client on
 * purpose: the bearer-injecting client would wait on the renewal it is performing.
 */
export class MapleAuthApi extends Context.Service<MapleAuthApi>()("@maple/web/MapleAuthApi", {
	make: Effect.gen(function* () {
		const httpClient = yield* HttpClient.HttpClient
		const provide = Effect.provideService(HttpClient.HttpClient, httpClient)
		const anonymous = yield* makeClient()
		return {
			login: (password: string) =>
				anonymous.authPublic.login({ payload: new SelfHostedLoginRequest({ password }) }),
			session: (token: string) =>
				makeClient(withBearer(token)).pipe(
					Effect.flatMap((client) => client.auth.session()),
					provide,
					Effect.mapError(classifySessionCheck),
				),
			refresh: (token: string) =>
				makeClient(withBearer(token)).pipe(
					Effect.flatMap((client) => client.auth.sessionRefresh()),
					provide,
					Effect.mapError(classifyRenewal),
				),
		}
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
