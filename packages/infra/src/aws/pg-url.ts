import * as Output from "alchemy/Output"
import * as Redacted from "effect/Redacted"

/**
 * alchemy renders a PlanetScale role's URL with `sslmode=verify-full`, which neither ECS
 * client parses: tokio-postgres (the gateway) and Electric know only disable/prefer/require.
 * Both verify the chain and hostname under `require` anyway, so nothing is lost.
 */
export const pgUrlRequireSsl = (url: Output.Output<Redacted.Redacted<string>>) =>
	Output.map(url, (value) =>
		Redacted.make(Redacted.value(value).replace("sslmode=verify-full", "sslmode=require")),
	)
