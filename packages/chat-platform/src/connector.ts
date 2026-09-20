/**
 * What a chat platform has to provide to be one of Maple's.
 *
 * The rule this package exists to enforce: everything that differs between one
 * chat vendor and the next lives in `src/connectors/<id>/`, behind this one
 * structured export. Nothing outside those directories — not the host Worker,
 * not the infrastructure, not a test — may know which vendors exist. Adding a
 * platform is a directory plus a line in `src/connectors/index.ts`.
 */
import type { ChatConnectorId } from "./connector-id.ts"
import type { ConnectorIngress } from "./ingress.ts"

export * from "./connector-id.ts"

export interface ChatConnector {
	readonly id: ChatConnectorId
	/** How the platform's events reach Maple. See `./ingress.ts`. */
	readonly ingress: ConnectorIngress
}
