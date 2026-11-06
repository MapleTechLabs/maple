import type { ChatConnectorManifest } from "../install"
import { discordManifest } from "./discord/manifest"
import { hazelManifest } from "./hazel/manifest"
import { slackManifest } from "./slack/manifest"

export type { ChatConnectorManifest } from "../install"

/** Short, so the registry stays one line: `vendor-isolation.test.ts` allows vendor names only there. */
type Manifest = ChatConnectorManifest

/**
 * The dashboard's half of the registry: every connector's presentation data,
 * with none of its runtime. Imported through `@maple/chat-platform/manifests`,
 * so the browser bundle never pulls a connector's install flow or its HTTP
 * client just to draw a card.
 */
export const chatConnectorManifests: ReadonlyArray<Manifest> = [discordManifest, hazelManifest, slackManifest]
