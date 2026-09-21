import type { HttpClient } from "effect/unstable/http"
import type { ChatConnector } from "../../connector"
import { socketIngress } from "../../ingress"
import { gatewayProtocol } from "./gateway"
import { DISCORD_CONNECTOR_ID } from "./id"
import { discordInstall } from "./install"
import { discordManifest } from "./manifest"
import { DiscordBotToken, discordOutbound } from "./outbound"

export { DiscordBotToken }

/**
 * Discord, every half: how it is installed, how its events arrive, how a turn is carried back.
 *
 * Its events arrive over the Gateway rather than a webhook — a mention reaches a bot no other way
 * — so `ingress` is the socket kind and the host keeps a connection open for it. `install` and the
 * rest are driven by a different Worker; see `README.md` in this directory for the one application
 * setup all of them depend on.
 */
export const discord: ChatConnector<HttpClient.HttpClient | DiscordBotToken> = {
	id: DISCORD_CONNECTOR_ID,
	manifest: discordManifest,
	install: discordInstall,
	outbound: discordOutbound,
	ingress: socketIngress(gatewayProtocol),
}
