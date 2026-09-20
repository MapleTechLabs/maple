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

export type ConnectorConfigResult =
	| { readonly _tag: "ready"; readonly config: ConnectorConfig }
	/** The names that are absent or blank, for the one log line a skipped connector gets. */
	| { readonly _tag: "missing"; readonly names: ReadonlyArray<string> }

/**
 * Resolve one connector's configuration off this Worker's env.
 *
 * A blank value counts as absent, for the same reason `@maple/infra/env` trims
 * on the way in: an empty binding is a value the connector would have to defend
 * against, where an absent one is a connector that does not start.
 */
export const resolveConnectorConfig = (
	env: Record<string, unknown>,
	connector: ChatConnector,
): ConnectorConfigResult => {
	const config = new Map<string, string>()
	const missing: string[] = []
	for (const key of connector.ingress.requiredConfig) {
		const value = env[key.name]
		if (typeof value === "string" && value.trim() !== "") {
			config.set(key.name, value.trim())
		} else {
			missing.push(key.name)
		}
	}
	return missing.length === 0 ? { _tag: "ready", config } : { _tag: "missing", names: missing }
}

/** The connectors whose events arrive over a long-lived socket rather than an HTTP request. */
export const socketConnectors = (
	registry: ReadonlyArray<ChatConnector>,
): ReadonlyArray<ChatConnector> =>
	registry.filter((connector) => connector.ingress.kind === "socket")
