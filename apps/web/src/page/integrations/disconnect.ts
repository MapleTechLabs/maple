import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Message, type StatusName } from "./message"

// Every provider's disconnect copy: the confirmation, its toasts, and the status reads a shared
// disconnect refreshes. AWS, Google Cloud and chat run their own mutation but read the copy here.

export interface DisconnectSpec {
	/** What the title names: `Disconnect <subject>?`. A connection's own name replaces it. */
	readonly subject: string
	readonly description: string
	readonly success: string
	readonly error: string
	readonly refresh: ReadonlyArray<StatusName>
}

export const disconnectTitle = (subject: string): string => `Disconnect ${subject}?`

const SPECS = {
	linear: {
		subject: "Linear",
		description: "Maple stops opening and updating Linear issues for incidents until you reconnect.",
		success: "Linear disconnected",
		error: "Couldn't disconnect Linear",
		refresh: ["linear"],
	},
	github: {
		subject: "GitHub",
		description:
			"This removes the Maple GitHub App connection and permanently deletes all synced repositories and their commit history from Maple. This cannot be undone. You can reconnect later, but everything will be re-synced from scratch.",
		success: "GitHub disconnected",
		error: "Couldn't disconnect GitHub",
		refresh: ["github"],
	},
	railway: {
		subject: "Railway",
		description: "Maple stops collecting metrics from your Railway projects. You can reconnect later.",
		success: "Railway disconnected",
		error: "Couldn't disconnect Railway",
		refresh: ["railway"],
	},
	supabase: {
		subject: "Supabase",
		description:
			"Maple revokes its access to your Supabase organization and stops collecting metrics from its projects. Data already collected stays. You can reconnect later.",
		success: "Supabase disconnected",
		error: "Couldn't disconnect Supabase",
		refresh: ["supabase"],
	},
	planetscale: {
		subject: "PlanetScale",
		description: "Maple stops collecting data from PlanetScale. You can reconnect later.",
		success: "PlanetScale organization disconnected",
		error: "Couldn't disconnect PlanetScale organization",
		refresh: ["planetscale", "planetscaleDatabases"],
	},
	cloudflare: {
		subject: "Cloudflare",
		description: "Maple stops collecting data from this Cloudflare account. You can reconnect later.",
		success: "Cloudflare account disconnected",
		error: "Couldn't disconnect Cloudflare",
		refresh: ["cloudflare"],
	},
	"cloudflare-multi": {
		subject: "Cloudflare",
		description:
			"Maple stops collecting data from all connected Cloudflare accounts. You can reconnect later.",
		success: "Cloudflare accounts disconnected",
		error: "Couldn't disconnect Cloudflare",
		refresh: ["cloudflare"],
	},
	aws: {
		subject: "AWS account",
		description:
			"Maple stops assuming the role and removes this source. Data already collected stays. Afterwards, delete the stack in AWS with the script Maple shows.",
		success: "AWS disconnected",
		error: "Couldn't disconnect AWS",
		refresh: ["aws"],
	},
	gcp: {
		subject: "Google Cloud",
		description: "",
		success: "Google Cloud disconnected",
		error: "Couldn't disconnect Google Cloud",
		refresh: ["gcp"],
	},
	chat: {
		subject: "workspace",
		description: "This workspace is unlinked from your organization immediately.",
		success: "Workspace disconnected",
		error: "Couldn't disconnect the workspace",
		refresh: [],
	},
} as const satisfies Record<string, DisconnectSpec>

export type DisconnectProvider = keyof typeof SPECS

export const disconnectSpec = (provider: DisconnectProvider): DisconnectSpec => SPECS[provider]

/** The specs a shared `Disconnect` runs, keyed by the integration it was confirmed for. */
export const DISCONNECTS: ReadonlyMap<string, DisconnectSpec> = new Map(Object.entries(SPECS))

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
