import type { HttpClient } from "effect/http"
import type { ChatConnector } from "../../connector"
import { socketIngress } from "../../ingress"
import type { ConnectorCredentials } from "../../outbound"
import { gatewayProtocol } from "./gateway"
import { HAZEL_CONNECTOR_ID } from "./id"
import { hazelInstall } from "./install"
import { hazelManifest } from "./manifest"
import { hazelOutbound } from "./outbound"

/**
 * Hazel, every half: how it is installed, how its events arrive, how a turn is carried back.
 *
 * Its events arrive over Hazel's bot gateway — a resumable WebSocket — so `ingress` is the socket
 * kind and the host keeps one connection open for it. There is no `identity` half: Hazel has no
 * way yet for a person to prove which Hazel account is theirs to Maple, so anyone in a linked
 * workspace may ask and approve, as the org-level connector identity (see `ChatConnector.identity`).
 * See `README.md` in this directory for the bot setup all of them depend on.
 */
export const hazel: ChatConnector<HttpClient.HttpClient | ConnectorCredentials> = {
	id: HAZEL_CONNECTOR_ID,
	manifest: hazelManifest,
	install: hazelInstall,
	outbound: hazelOutbound,
	ingress: socketIngress(gatewayProtocol),
}
