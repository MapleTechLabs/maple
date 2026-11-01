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
	readonly error: string
	readonly refresh: ReadonlyArray<StatusName>
}

export const DISCONNECTS = new Map<string, DisconnectSpec>([
	[
		"linear",
		{
			title: "Disconnect Linear",
			description: "Maple stops opening and updating Linear issues for incidents until you reconnect.",
			confirmLabel: "Disconnect",
			success: "Linear disconnected",
			error: "Couldn't disconnect Linear",
			refresh: ["linear"],
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
			error: "Couldn't disconnect GitHub",
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
			error: "Couldn't disconnect Railway",
			refresh: ["railway"],
		},
	],
	[
		"supabase",
		{
			title: "Disconnect Supabase",
			description:
				"Maple revokes its access to your Supabase organization and stops collecting metrics from its projects. Data already collected stays. You can reconnect later.",
			confirmLabel: "Disconnect",
			success: "Supabase disconnected",
			error: "Couldn't disconnect Supabase",
			refresh: ["supabase"],
		},
	],
	[
		"planetscale",
		{
			title: "Disconnect PlanetScale",
			description: "Maple stops collecting data from PlanetScale. You can reconnect later.",
			confirmLabel: "Disconnect",
			success: "PlanetScale organization disconnected",
			error: "Couldn't disconnect PlanetScale organization",
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
			error: "Couldn't disconnect Cloudflare",
			refresh: ["cloudflare"],
		},
	]),
])

const mutation = (integration: string) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		const v2 = yield* MapleApiV2Client
		switch (integration) {
			case "linear":
				return yield* Effect.asVoid(internal.integrations.linearDisconnect())
			case "github":
				return yield* Effect.asVoid(internal.integrations.githubDisconnect())
			case "planetscale":
				return yield* Effect.asVoid(v2.planetscaleIntegration.disconnect())
			case "railway":
				return yield* Effect.asVoid(internal.integrations.railwayDisconnect())
			case "supabase":
				return yield* Effect.asVoid(internal.integrations.supabaseDisconnect())
			case "cloudflare":
			case "cloudflare-multi":
				return yield* Effect.asVoid(internal.integrations.cloudflareDisconnect())
			default:
				return yield* Effect.void
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
				onSuccess: () => Message.CompletedDisconnect({ integration, failure: null }),
			}),
		),
})
