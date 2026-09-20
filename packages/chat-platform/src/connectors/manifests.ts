import type { ChatConnectorManifest } from "../install"
import { discordManifest } from "./discord/manifest"

export type { ChatConnectorIcon, ChatConnectorManifest, ChatConnectorSettingsField } from "../install"

/**
 * The dashboard's half of the registry: every connector's presentation data,
 * with none of its runtime. Imported through `@maple/chat-platform/manifests`,
 * so the browser bundle never pulls a connector's install flow or its HTTP
 * client just to draw a card.
 */
export const chatConnectorManifests: ReadonlyArray<ChatConnectorManifest> = [discordManifest]
