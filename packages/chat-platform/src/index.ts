import { Option } from "effect"
import type { ChatConnector } from "./connector"
import { connectors } from "./connectors/index"

export * from "./connector"
export * from "./config"
export * from "./install"
export { connectors } from "./connectors/index"
export { chatConnectorManifests } from "./connectors/manifests"

/** The registered connector with this id, if Maple ships one. */
export const findConnector = (id: string): Option.Option<ChatConnector> =>
	Option.fromNullishOr(connectors.find((connector) => connector.id === id))

/** Whether a deployment supplied every config value this connector declared. */
export const isConnectorConfigured = (
	connector: ChatConnector,
	config: ReadonlyMap<string, unknown>,
): boolean => connector.install.requiredConfig.every((name) => config.has(name))
