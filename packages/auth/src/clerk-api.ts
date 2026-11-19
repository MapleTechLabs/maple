import * as Clerk from "@distilled.cloud/clerk"
import { Layer, Option, type Redacted } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"

/** What every `@distilled.cloud/clerk` operation needs to run. */
export type ClerkApiServices = Clerk.Credentials | HttpClient.HttpClient

/** The deployment's Clerk Backend API: a secret key and an HTTP client for the distilled operations. */
export type ClerkApi = Layer.Layer<ClerkApiServices>

/** A Clerk Backend API from a secret key; tests pass their own HTTP layer. */
export const makeClerkApi = (
	secretKey: Redacted.Redacted,
	http: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): ClerkApi => Layer.merge(Clerk.fromApiKey({ apiKey: secretKey }), http)

const clerkApis = new WeakMap<object, ClerkApi>()

/** The deployment's Clerk Backend API, built once per env; `undefined` without a secret key. */
export const clerkApiFor = (env: {
	readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted>
}): ClerkApi | undefined => {
	if (Option.isNone(env.CLERK_SECRET_KEY)) return undefined
	const cached = clerkApis.get(env)
	if (cached !== undefined) return cached
	const api = makeClerkApi(env.CLERK_SECRET_KEY.value)
	clerkApis.set(env, api)
	return api
}
