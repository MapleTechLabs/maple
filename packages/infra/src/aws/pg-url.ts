import * as Output from "alchemy/Output"
import * as Redacted from "effect/Redacted"

/**
 * A Postgres URL both ECS clients parse: tokio-postgres (the gateway) and Electric know only
 * `sslmode=disable|prefer|require` (PlanetScale renders `verify-full`) and reject Neon's
 * `channel_binding`. Both verify the chain and hostname under `require` anyway.
 */
export const pgUrlRequireSsl = (url: Output.Output<Redacted.Redacted<string>>) =>
	Output.map(url, (value) => {
		const parsed = new URL(Redacted.value(value))
		parsed.searchParams.set("sslmode", "require")
		parsed.searchParams.delete("channel_binding")
		return Redacted.make(parsed.toString())
	})
