import type { ChatConnector } from "./connector"

export * from "./connector"
export * from "./config"
export * from "./install"
export { connectors } from "./connectors/index"
export { chatConnectorManifests } from "./connectors/manifests"

/** Whether a deployment supplied every config value this connector declared. */
export const isConnectorConfigured = (
	connector: ChatConnector,
	config: ReadonlyMap<string, unknown>,
): boolean => connector.install.requiredConfig.every((name) => config.has(name))
