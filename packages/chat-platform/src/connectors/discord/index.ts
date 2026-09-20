import type { HttpClient } from "effect/unstable/http"
import type { ChatConnector } from "../../connector"
import { socketIngress } from "../../ingress"
import { gatewayProtocol } from "./gateway"
import { DISCORD_CONNECTOR_ID } from "./id"
import { DiscordBotToken, discordOutbound } from "./outbound"

export { DiscordBotToken }

/**
 * Discord, both halves.
 *
 * Its events arrive over the Gateway rather than a webhook — a mention reaches a bot no other way
 * — so `ingress` is the socket kind and the host keeps a connection open for it. See `README.md`
 * in this directory for the application setup both halves depend on.
 */
export const discord: ChatConnector<HttpClient.HttpClient | DiscordBotToken> = {
	id: DISCORD_CONNECTOR_ID,
	outbound: discordOutbound,
	ingress: socketIngress(gatewayProtocol),
}
