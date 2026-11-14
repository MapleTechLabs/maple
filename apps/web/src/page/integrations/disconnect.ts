import { Effect, Schema, Record as Rec } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Message, type StatusName } from "./message"
import { type ProviderId, PROVIDERS } from "../kit/providers"

// Every provider's disconnect copy: the confirmation, its toasts, and the status reads a shared
// disconnect refreshes. AWS, Google Cloud and chat run their own mutation but read the copy here.

export interface DisconnectSpec {
	/** What the title names: `Disconnect <subject>?`. A connection's own name replaces it. */
	readonly subject: string
	readonly description: string
	readonly success: string
	/** The success toast's type and description when the disconnect left something to clean up. */
	readonly successType?: "warning"
	readonly successDescription?: string
	readonly error: string
	readonly refresh: ReadonlyArray<StatusName>
}

export const disconnectTitle = (subject: string): string => `Disconnect ${subject}?`

/** A provider's copy in its registry name: `<Name> disconnected`, `Couldn't disconnect <Name>`. */
const named = (id: ProviderId, description: string, refresh: ReadonlyArray<StatusName>): DisconnectSpec => {
	const name = PROVIDERS[id].name
	return {
		subject: name,
		description,
		success: `${name} disconnected`,
		error: `Couldn't disconnect ${name}`,
		refresh,
	}
}

const SPECS = {
	linear: named(
		"linear",
		"Maple stops opening and updating Linear issues for incidents until you reconnect.",
		["linear"],
	),
	github: named(
		"github",
		"This removes the Maple GitHub App connection and permanently deletes all synced repositories and their commit history from Maple. This cannot be undone. You can reconnect later, but everything will be re-synced from scratch.",
		["github"],
	),
	vercel: named("vercel", "", ["vercel"]),
	railway: named(
		"railway",
		"Maple stops collecting metrics from your Railway projects. You can reconnect later.",
		["railway"],
	),
	supabase: named(
		"supabase",
		"Maple revokes its access to your Supabase organization and stops collecting metrics from its projects. Data already collected stays. You can reconnect later.",
		["supabase"],
	),
	planetscale: {
		...named("planetscale", "Maple stops collecting data from PlanetScale. You can reconnect later.", [
			"planetscale",
			"planetscaleDatabases",
		]),
		success: "PlanetScale organization disconnected",
		error: "Couldn't disconnect PlanetScale organization",
	},
	cloudflare: {
		...named(
			"cloudflare",
			"Maple stops collecting data from this Cloudflare account. You can reconnect later.",
			["cloudflare"],
		),
		success: "Cloudflare account disconnected",
	},
	"cloudflare-multi": {
		...named(
			"cloudflare",
			"Maple stops collecting data from all connected Cloudflare accounts. You can reconnect later.",
			["cloudflare"],
		),
		success: "Cloudflare accounts disconnected",
	},
	aws: {
		...named(
			"aws",
			"Maple stops assuming the role and removes this source. Data already collected stays. Afterwards, delete the stack in AWS with the script Maple shows.",
			["aws"],
		),
		subject: "AWS account",
	},
	gcp: named("gcp", "", ["gcp"]),
	"google-search-console": named(
		"google-search-console",
		"Maple revokes its access to your Google account and stops importing Search Console data. Data already imported stays. You can reconnect later.",
		["searchConsole"],
	),
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
export const DISCONNECTS: ReadonlyMap<string, DisconnectSpec> = new Map<string, DisconnectSpec>([
	...Rec.toEntries(SPECS),
	[
		/** Disconnected, but Maple could not delete the drains on Vercel. */
		"vercel-drains-left",
		{
			...SPECS.vercel,
			success: "Remove the drains on Vercel",
			successType: "warning",
			successDescription:
				"Maple couldn't delete them. In the team's drain settings, delete every drain whose name starts with Maple.",
		},
	],
])

/** The disconnect; answers the `DISCONNECTS` key its toast and refreshes come from. */
const mutation = (integration: string) =>
	Effect.gen(function* () {
		const internal = yield* MapleInternalApiClient
		const v2 = yield* MapleApiV2Client
		switch (integration) {
			case "linear":
				yield* internal.integrations.linearDisconnect()
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
			case "supabase":
				yield* internal.integrations.supabaseDisconnect()
				return integration
			case "google-search-console":
				yield* internal.integrations.searchConsoleDisconnect()
				return integration
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
				onSuccess: (reported) =>
					Message.CompletedDisconnect({ integration: reported, failure: null }),
			}),
		),
})
