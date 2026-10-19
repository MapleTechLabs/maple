import type { ChatConnectorManifest } from "../../install"
import { SLACK_CONNECTOR_ID } from "./id"

/**
 * Pure data — imported by the dashboard through `@maple/chat-platform/manifests`, which is why
 * this module must stay free of anything that pulls the connector's runtime (the install flow, its
 * HTTP client, its outbound Web API calls).
 *
 * No settings fields. The one setting the other connector carries names an approver role, and
 * Slack's interaction payload reports no roles and no administrator flag for whoever pressed a
 * button — so a field here would ask an admin to configure something nothing can enforce. See this
 * directory's README.
 */
export const slackManifest: ChatConnectorManifest = {
	id: SLACK_CONNECTOR_ID,
	name: "Slack",
	description: "Add the Maple bot to a Slack workspace and link that workspace to your Maple organization.",
	icon: {
		viewBox: "0 0 24 24",
		paths: [
			{
				fill: "#36C5F0",
				d: "M9.04 2.5A2.04 2.04 0 0 0 7 4.54a2.04 2.04 0 0 0 2.04 2.04h2.04V4.54A2.04 2.04 0 0 0 9.04 2.5m0 5.44H3.6a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04",
			},
			{
				fill: "#2EB67D",
				d: "M21.5 9.98a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04v2.04h2.04a2.04 2.04 0 0 0 2.04-2.04m-5.44 0V4.54A2.04 2.04 0 0 0 14.02 2.5a2.04 2.04 0 0 0-2.04 2.04v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04",
			},
			{
				fill: "#ECB22E",
				d: "M14.02 21.5a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-2.04v2.04a2.04 2.04 0 0 0 2.04 2.04m0-5.44h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-5.44a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04",
			},
			{
				fill: "#E01E5A",
				d: "M1.56 14.02a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-2.04H3.6a2.04 2.04 0 0 0-2.04 2.04m5.44 0v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-5.44a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04",
			},
		],
	},
	// Slack's aubergine on light; on the dark card the aubergine is darker than the card itself,
	// so the same hue lifted to stay visible (the dashboard's `SLACK_ACCENT`).
	accent: "light-dark(#4A154B, #AD51A7)",
	settingsFields: [],
}
