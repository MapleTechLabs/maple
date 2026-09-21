import type { HttpClient } from "effect/unstable/http"
import type { ChatConnector } from "../../connector"
import { DISCORD_CONNECTOR_ID } from "./id"
import { DiscordBotToken, discordOutbound } from "./outbound"

export { DiscordBotToken }

export const discord: ChatConnector<HttpClient.HttpClient | DiscordBotToken> = {
	id: DISCORD_CONNECTOR_ID,
	outbound: discordOutbound,
}
