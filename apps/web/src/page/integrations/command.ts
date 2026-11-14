import { readClock } from "@maple/views/data/timing"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Effect, type Result, Schema } from "effect"
import { Command } from "foldkit"
import { IntegrationStatuses } from "../../data/integration-statuses"
import { type LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Message, type StatusName } from "./message"
import { completeOAuthReturn } from "./oauth-return"
import { BillingCustomerCache } from "../../data/billing-customer"
import { readGrants } from "../../data/session-tenant"
import { organizationFeatureFlagsFrom } from "@maple/domain/organization-feature-flags"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import { trackProduct } from "../../data/analytics"
import { readAllPages } from "../../platform/read-all-pages"
import { RAILWAY } from "../infra-integrations/railway/integration/railway-provider"
import { SUPABASE } from "../infra-integrations/supabase/integration/supabase-provider"
import { SEARCH_CONSOLE_STATUS_READ } from "./search-console"
import { LINEAR_STATUS_READ } from "./linear-provider"
import { CHAT_STATUS_READ } from "./chat"
import { VERCEL_STATUS_READ } from "../infra-integrations/vercel/integration/vercel"
import { PLANETSCALE_STATUS_READ } from "../infra-integrations/planetscale/integration/planetscale"
import { CLOUDFLARE_STATUS_READ } from "../infra-integrations/cloudflare/integration/cloudflare"

const RefreshArgs = { key: Schema.String, refresh: Schema.Boolean }

/** Finishes a provider return the URL fragment carries (`oauth-return.ts`); a no-op otherwise. */
export const CompleteOAuthReturn = Command.define("CompleteIntegrationsOAuthReturn", {
	messages: [Message.CompletedOAuthReturn],
	execute: Effect.map(completeOAuthReturn, (outcome) => Message.CompletedOAuthReturn({ outcome })),
})

/** Sequences the URL cleanup after the toast: one OutMessage per update. */
export const StripChatParams = Command.define("StripIntegrationsChatParams", {
	messages: [Message.CompletedChatToast],
	execute: Effect.succeed(Message.CompletedChatToast()),
})

export const ReadClock = readClock("ReadIntegrationsClock", Message.CompletedReadClock)

type StatusDone<A> = Schema.Top &
	((fields: { readonly key: string; readonly result: Result.Result<A, LoadFailure> }) => Message)

/** One status read: `refresh` only matters to the reads the sidebar shares (`IntegrationStatuses`). */
const statusRead = <const Name extends string, A, E, R>(
	name: Name,
	done: StatusDone<A>,
	read: (refresh: boolean) => Effect.Effect<A, E, R>,
) =>
	Command.define(name, {
		args: RefreshArgs,
		messages: [done],
		execute: ({ key, refresh }) => read(refresh).pipe(settleTo((result) => done({ key, result }))),
	})

/** Every status read the page makes, by its slot in `Statuses`. */
export const STATUS_READS = {
	cloudflare: statusRead(
		CLOUDFLARE_STATUS_READ.name,
		Message.CompletedLoadCloudflare,
		CLOUDFLARE_STATUS_READ.read,
	),
	railway: statusRead(RAILWAY.statusRead.name, Message.CompletedLoadRailway, RAILWAY.statusRead.read),
	vercel: statusRead(VERCEL_STATUS_READ.name, Message.CompletedLoadVercel, VERCEL_STATUS_READ.read),
	planetscale: statusRead(
		PLANETSCALE_STATUS_READ.name,
		Message.CompletedLoadPlanetscale,
		PLANETSCALE_STATUS_READ.read,
	),
	gcp: statusRead("LoadIntegrationsGcpStatus", Message.CompletedLoadGcp, (refresh) =>
		Effect.flatMap(IntegrationStatuses, (statuses) => statuses.gcp({ refresh })),
	),
	supabase: statusRead(SUPABASE.statusRead.name, Message.CompletedLoadSupabase, SUPABASE.statusRead.read),
	aws: statusRead("LoadIntegrationsAwsStatus", Message.CompletedLoadAws, () =>
		Effect.flatMap(MapleApiV2Client, (client) => client.awsIntegration.status()),
	),
	/** The poller's inventory of PlanetScale databases. */
	planetscaleDatabases: statusRead(
		"LoadIntegrationsPlanetscaleDatabases",
		Message.CompletedLoadPlanetscaleDatabases,
		() => Effect.flatMap(MapleApiV2Client, (client) => client.planetscaleIntegration.databases()),
	),
	linear: statusRead(LINEAR_STATUS_READ.name, Message.CompletedLoadLinear, LINEAR_STATUS_READ.read),
	searchConsole: statusRead(
		SEARCH_CONSOLE_STATUS_READ.name,
		Message.CompletedLoadSearchConsole,
		SEARCH_CONSOLE_STATUS_READ.read,
	),
	github: statusRead("LoadIntegrationsGithubStatus", Message.CompletedLoadGithub, () =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.integrations.githubStatus()),
	),
	chat: statusRead(CHAT_STATUS_READ.name, Message.CompletedLoadChat, CHAT_STATUS_READ.read),
	/** Every page of 100. */
	scrapeTargets: statusRead("LoadIntegrationsScrapeTargets", Message.CompletedLoadScrapeTargets, () =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			collectV2Pages((cursor) =>
				client.scrapeTargets.list({
					query: { limit: 100, ...(cursor !== undefined ? { cursor } : undefined) },
				}),
			),
		),
	),
	/** The org's data sources (`dataSources` flag), every page, for the hub's rows. */
	dataSources: statusRead("LoadIntegrationsDataSources", Message.CompletedLoadDataSources, () =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			readAllPages((cursor) => client.dataSources.list({ query: { limit: 100, cursor } })),
		),
	),
} satisfies { readonly [K in StatusName]: unknown }

/** A successful callback is the `integration_connected` product event. */
export const TrackConnected = Command.define("TrackIntegrationConnected", {
	args: { provider: Schema.String },
	messages: [Message.CompletedTrackConnected],
	execute: ({ provider }) =>
		trackProduct("integration_connected", { provider }).pipe(
			Effect.as(Message.CompletedTrackConnected()),
		),
})

/** A confirmed disconnect is the `integration_disconnected` product event. */
export const TrackDisconnected = Command.define("TrackIntegrationDisconnected", {
	args: { provider: Schema.String },
	messages: [Message.CompletedTrackDisconnected],
	execute: ({ provider }) =>
		trackProduct("integration_disconnected", { provider }).pipe(
			Effect.as(Message.CompletedTrackDisconnected()),
		),
})

/** The session the shell already read (`SessionTenant`): the settings rail and connecting read its grants. */
export const LoadSession = Command.define("LoadIntegrationsSession", {
	messages: [Message.CompletedLoadSession],
	execute: Effect.map(readGrants, (grants) =>
		Message.CompletedLoadSession({
			grants,
			hasDataSources:
				!isClerkAuthEnabled ||
				organizationFeatureFlagsFrom(window.Clerk?.organization?.publicMetadata).dataSources,
		}),
	),
})

export const LoadCustomer = Command.define("LoadIntegrationsCustomer", {
	args: { key: Schema.String, orgId: Schema.String },
	messages: [Message.CompletedLoadCustomer],
	execute: ({ key, orgId }) =>
		Effect.gen(function* () {
			return yield* (yield* BillingCustomerCache).get({ orgId })
		}).pipe(settleTo((result) => Message.CompletedLoadCustomer({ key, result }))),
})
