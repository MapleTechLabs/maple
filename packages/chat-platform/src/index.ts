import type { ChatConnector } from "./connector"

export * from "./action-token"
export * from "./config"
export * from "./connector"
export * from "./driver"
export * from "./ingress"
export * from "./install"
export * from "./outbound"
export * from "./render"
export * from "./settings"

/** Whether a deployment supplied every config value this connector's INSTALL half declared. */
export const isConnectorConfigured = <R>(
	connector: ChatConnector<R>,
	config: ReadonlyMap<string, unknown>,
): boolean => connector.install.requiredConfig.every((key) => config.has(key.name))
