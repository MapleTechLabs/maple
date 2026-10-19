// BOUNDARY: This module owns unparsed Worker env values and narrows them before use.
/**
 * Cloudflare places only fetch handlers, so a cron fire or a queue batch runs wherever it lands,
 * far from the database. A Worker hands that work to its own placed fetch handler over a self
 * service binding, authenticated with a bearer secret.
 */
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Config, Effect, Option, Redacted } from "effect"

const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function"

/** Surfaces a 3xx as the response instead of following it, so the bearer never leaves the hop. */
const withManualRedirects = (binding: Fetcher): Fetcher => ({
	fetch: (input, init) => binding.fetch(input, { ...init, redirect: "manual" }),
	connect: (address, options) => binding.connect(address, options),
})

/** The self service binding `name` declared in the Worker's props, if this env has it. */
export const selfFetcher = (env: Record<string, unknown>, name: string): Option.Option<Fetcher> => {
	const binding = env[name]
	return isFetcher(binding) ? Option.some(withManualRedirects(binding)) : Option.none()
}

/** The secret `name` as this invocation's env says; unreadable reads as unset. */
export const workerSecretFor = (env: Record<string, unknown>, name: string) =>
	Config.option(Config.Redacted(name)).pipe(
		Effect.map(Option.map(Redacted.value)),
		Effect.orElseSucceed(() => Option.none<string>()),
		// The invocation's env is the boundary this config belongs to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(workerEnvLayer(env)),
	)

/** The internal token as this invocation's env says; unreadable reads as unset. */
export const internalTokenFor = (env: Record<string, unknown>) =>
	workerSecretFor(env, "INTERNAL_SERVICE_TOKEN")
