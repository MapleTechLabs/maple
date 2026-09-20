import type { ChatConnector } from "../../connector"
import { DISCORD_CONNECTOR_ID, discordInstall } from "./install"
import { discordManifest } from "./manifest"

export const discord: ChatConnector = {
	id: DISCORD_CONNECTOR_ID,
	manifest: discordManifest,
	install: discordInstall,
}
