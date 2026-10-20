import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Message, type StatusName } from "./message"

// Each integration's disconnect: the confirmation copy, the mutation, its toasts, and the status
// reads its `reactivityKeys` refresh (`useIntegrationDisconnect` + `ConfirmDialog`).

export interface DisconnectSpec {
	readonly title: string
	readonly description: string
	readonly confirmLabel: string
	readonly success: string
	/** The success toast's type and description when the disconnect left something to clean up. */
	readonly successType?: "warning"
	readonly successDescription?: string
	readonly error: string
	readonly refresh: ReadonlyArray<StatusName>
}

const VERCEL_DISCONNECT: DisconnectSpec = {
	title: "Disconnect Vercel?",
	description: "",
	confirmLabel: "Disconnect",
	success: "Vercel disconnected",
	error: "Failed to disconnect Vercel",
	refresh: ["vercel"],
}

export const DISCONNECTS = new Map<string, DisconnectSpec>([
	[
		"hazel",
		{
			title: "Disconnect Hazel",
			description: "Alerts routed to Hazel stop being delivered until you reconnect.",
			confirmLabel: "Disconnect",
			success: "Hazel disconnected",
			error: "Failed to disconnect Hazel",
			refresh: ["hazel"],
		},
	],
	[
		"github",
		{
			title: "Disconnect GitHub",
			description:
				"This removes the Maple GitHub App connection and permanently deletes all synced repositories and their commit history from Maple. This cannot be undone. You can reconnect later, but everything will be re-synced from scratch.",
			confirmLabel: "Disconnect",
			success: "GitHub disconnected",
			error: "Failed to disconnect GitHub",
			refresh: ["github"],
		},
	],
	[
		"railway",
		{
			title: "Disconnect Railway",
			description:
				"Maple stops collecting metrics from your Railway projects. You can reconnect later.",
			confirmLabel: "Disconnect",
			success: "Railway disconnected",
			error: "Failed to disconnect Railway",
			refresh: ["railway"],
		},
	],
	["vercel", VERCEL_DISCONNECT],
	[
		/** Disconnected, but Maple could not delete the drains on Vercel. */
		"vercel-drains-left",
		{
			...VERCEL_DISCONNECT,
			success: "Remove the drains on Vercel",
			successType: "warning",
			successDescription:
				"Maple couldn't delete them. Delete Maple logs and Maple traces in the team's drain settings.",
		},
	],
	[
		"planetscale",
		{
			title: "Disconnect PlanetScale",
			description: "Maple stops collecting data from PlanetScale. You can reconnect later.",
			confirmLabel: "Disconnect",
			success: "PlanetScale organization disconnected",
			error: "Failed to disconnect PlanetScale organization",
			refresh: ["planetscale", "planetscaleDatabases"],
		},
	],
	...(["cloudflare", "cloudflare-multi"] as const).map((key): readonly [string, DisconnectSpec] => [
		key,
		{
			title: "Disconnect Cloudflare",
			description: "",
			confirmLabel: "Disconnect",
			success:
				key === "cloudflare" ? "Cloudflare account disconnected" : "Cloudflare accounts disconnected",
			error: "Failed to disconnect Cloudflare",
			refresh: ["cloudflare"],
		},
	]),
])

/** The disconnect; answers the `DISCONNECTS` key its toast and refreshes come from. */
const mutation = (integration: string) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		const v2 = yield* MapleApiV2Client
		switch (integration) {
			case "hazel":
				yield* internal.integrations.hazelDisconnect()
				return integration
			case "github":
				yield* internal.integrations.githubDisconnect()
				return integration
			case "planetscale":
				yield* v2.planetscaleIntegration.disconnect()
				return integration
			case "railway":
				yield* internal.integrations.railwayDisconnect()
				return integration
			case "vercel": {
				const result = yield* internal.integrations.vercelDisconnect()
				return result.drainsRemoved ? integration : "vercel-drains-left"
			}
			case "cloudflare":
			case "cloudflare-multi":
				yield* internal.integrations.cloudflareDisconnect()
				return integration
			default:
				return integration
		}
	})

export const Disconnect = Command.define("DisconnectIntegration", {
	args: { integration: Schema.String },
	messages: [Message.CompletedDisconnect],
	execute: ({ integration }) =>
		mutation(integration).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedDisconnect({ integration, failure: toLoadFailure(error) }),
				onSuccess: (reported) => Message.CompletedDisconnect({ integration: reported, failure: null }),
			}),
		),
})
