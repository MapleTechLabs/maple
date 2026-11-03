import type { ChatConnector } from "./connector"
import { Array as Arr } from "effect"

export * from "./action-token"
export * from "./config"
export * from "./connector"
export * from "./driver"
export * from "./identity"
export * from "./ingress"
export * from "./install"
export * from "./outbound"
export * from "./render"

/** Whether a deployment supplied every config value this connector's INSTALL half declared. */
export const isConnectorConfigured = <R>(
	connector: ChatConnector<R>,
	config: ReadonlyMap<string, unknown>,
): boolean => Arr.every(connector.install.requiredConfig, (key) => config.has(key.name))
