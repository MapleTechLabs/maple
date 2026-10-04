/**
 * The runtime half of connector configuration: the env this Worker was deployed
 * with, resolved into the values one connector asked for.
 *
 * Generic throughout — a connector declares names and whether each is a secret,
 * and this resolves them without knowing which platform any of them belongs to.
 * The deploy-time declarations live in `./resources/env.ts`, deliberately apart
 * so the deploy graph stays out of the bundle.
 */
import type { ChatConnector, ConnectorConfig } from "@maple/chat-platform"
import { Config, Effect, Option, Redacted } from "effect"

/**
 * The half of a connector this Worker touches.
 *
 * Structural rather than `ChatConnector<R>` itself: `R` is what a connector's OUTBOUND needs from
 * its host — an HTTP client, a credential service — and the registry's element type unions every
 * registered connector's requirements. Ingress has no requirements of its own, so naming just the
 * two members it reads keeps those out of every signature on this path.
 */
export type IngressConnector = Pick<ChatConnector, "id" | "ingress">

export type ConnectorConfigResult =
	| { readonly _tag: "ready"; readonly config: ConnectorConfig }
	/** The names that are absent or blank, for the one log line a skipped connector gets. */
	| { readonly _tag: "missing"; readonly names: ReadonlyArray<string> }

const trimmedNonBlank = (value: string): Option.Option<string> => {
	const trimmed = value.trim()
	return trimmed === "" ? Option.none() : Option.some(trimmed)
}

/**
 * One optional string setting, trimmed, with a blank value counted as absent: an empty binding is
 * a value a caller would have to defend against, where an absent one is a feature that does not
 * start. A binding that is not a string (a namespace under the same name) reads as absent too.
 */
export const optionalSetting = (name: string): Config.Config<Option.Option<string>> =>
	Config.String(name).pipe(
		Config.map(trimmedNonBlank),
		Config.orElse(() => Config.succeed(Option.none<string>())),
	)

/** {@link optionalSetting} for a secret: kept `Redacted` until the one place that uses it. */
export const optionalSecret = (name: string): Config.Config<Option.Option<Redacted.Redacted<string>>> =>
	optionalSetting(name).pipe(Config.map(Option.map((value) => Redacted.make(value))))

/**
 * Resolve one connector's configuration through the ambient `ConfigProvider` (the Worker env's,
 * via `workerEnvLayer`). The resolved map is the connector's own input, so values leave it plain.
 */
export const resolveConnectorConfig = (connector: IngressConnector): Effect.Effect<ConnectorConfigResult> =>
	Effect.forEach(connector.ingress.requiredConfig, (key) =>
		Effect.map(optionalSetting(key.name), (value) => [key.name, value] as const),
	).pipe(
		Effect.map((entries): ConnectorConfigResult => {
			const config = new Map<string, string>()
			const missing: string[] = []
			for (const [name, value] of entries) {
				if (Option.isSome(value)) config.set(name, value.value)
				else missing.push(name)
			}
			return missing.length === 0 ? { _tag: "ready", config } : { _tag: "missing", names: missing }
		}),
		// `optionalSetting` recovers every ConfigError, so this cannot fail; the type just cannot see it.
		Effect.orDie,
	)

/** The connectors whose events arrive over a long-lived socket rather than an HTTP request. */
export const socketConnectors = (
	registry: ReadonlyArray<IngressConnector>,
): ReadonlyArray<IngressConnector> => registry.filter((connector) => connector.ingress.kind === "socket")
