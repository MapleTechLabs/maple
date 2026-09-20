import type { ChatConnector } from "../../connector.ts"
import { socketIngress } from "../../ingress.ts"
import { gatewayProtocol } from "./gateway.ts"
import { CONNECTOR_ID } from "./id.ts"

/**
 * Discord, over the Gateway.
 *
 * A mention only reaches a bot over the persistent socket — Discord has no
 * webhook that delivers one — so this connector's ingress is the socket kind and
 * the host keeps a connection open for it. See `README.md` in this directory for
 * the application setup that has to exist before any of it runs.
 */
export const discord: ChatConnector = {
	id: CONNECTOR_ID,
	ingress: socketIngress(gatewayProtocol),
}
