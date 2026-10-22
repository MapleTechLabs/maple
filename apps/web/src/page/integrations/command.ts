import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { IntegrationStatuses } from "../../data/integration-statuses"
import { toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../platform/api-clients"
import { Message } from "./message"
import { completeOAuthReturn } from "./oauth-return"
import { BillingCustomerCache } from "../../data/billing-customer"
import { readIsOrgAdmin } from "../../data/session-tenant"
import { trackProduct } from "../../data/analytics"

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result)

const Args = { key: Schema.String }
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

export const ReadClock = Command.define("ReadIntegrationsClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** The four statuses the sidebar also reads: one request each, shared (`IntegrationStatuses`). */
export const LoadCloudflare = Command.define("LoadIntegrationsCloudflareStatus", {
	args: RefreshArgs,
	messages: [Message.CompletedLoadCloudflare],
	execute: ({ key, refresh }) =>
		Effect.map(
			settle(
				Effect.gen(function* () {
					const statuses = yield* IntegrationStatuses
					return yield* statuses.cloudflare({ refresh })
				}),
			),
			(result) => Message.CompletedLoadCloudflare({ key, result }),
		),
})

export const LoadRailway = Command.define("LoadIntegrationsRailwayStatus", {
	args: RefreshArgs,
	messages: [Message.CompletedLoadRailway],
	execute: ({ key, refresh }) =>
		Effect.map(
			settle(
				Effect.gen(function* () {
					const statuses = yield* IntegrationStatuses
					return yield* statuses.railway({ refresh })
				}),
			),
			(result) => Message.CompletedLoadRailway({ key, result }),
		),
})

export const LoadPlanetscale = Command.define("LoadIntegrationsPlanetscaleStatus", {
	args: RefreshArgs,
	messages: [Message.CompletedLoadPlanetscale],
	execute: ({ key, refresh }) =>
		Effect.map(
			settle(
				Effect.gen(function* () {
					const statuses = yield* IntegrationStatuses
					return yield* statuses.planetscale({ refresh })
				}),
			),
			(result) => Message.CompletedLoadPlanetscale({ key, result }),
		),
})

export const LoadGcp = Command.define("LoadIntegrationsGcpStatus", {
	args: RefreshArgs,
	messages: [Message.CompletedLoadGcp],
	execute: ({ key, refresh }) =>
		Effect.map(
			settle(
				Effect.gen(function* () {
					const statuses = yield* IntegrationStatuses
					return yield* statuses.gcp({ refresh })
				}),
			),
			(result) => Message.CompletedLoadGcp({ key, result }),
		),
})

/** Shared with the sidebar and /infra/supabase through `IntegrationStatuses`. */
export const LoadSupabase = Command.define("LoadIntegrationsSupabaseStatus", {
	args: RefreshArgs,
	messages: [Message.CompletedLoadSupabase],
	execute: ({ key, refresh }) =>
		Effect.map(
			settle(
				Effect.gen(function* () {
					const statuses = yield* IntegrationStatuses
					return yield* statuses.supabase({ refresh })
				}),
			),
			(result) => Message.CompletedLoadSupabase({ key, result }),
		),
})

/** `retainedQueryV2("planetscaleIntegration", "databases")`: the poller's inventory. */
export const LoadPlanetscaleDatabases = Command.define("LoadIntegrationsPlanetscaleDatabases", {
	args: Args,
	messages: [Message.CompletedLoadPlanetscaleDatabases],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.planetscaleIntegration.databases()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadPlanetscaleDatabases({ key, result })),
		),
})

export const LoadHazel = Command.define("LoadIntegrationsHazelStatus", {
	args: Args,
	messages: [Message.CompletedLoadHazel],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.hazelStatus()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadHazel({ key, result })),
		),
})

export const LoadGithub = Command.define("LoadIntegrationsGithubStatus", {
	args: Args,
	messages: [Message.CompletedLoadGithub],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.githubStatus()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadGithub({ key, result })),
		),
})

export const LoadChat = Command.define("LoadIntegrationsChatConnectors", {
	args: Args,
	messages: [Message.CompletedLoadChat],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			return yield* client.chatIntegration.connectors()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadChat({ key, result })),
		),
})

/** `scrapeTargetsListAtom`: every page of 100. */
export const LoadScrapeTargets = Command.define("LoadIntegrationsScrapeTargets", {
	args: Args,
	messages: [Message.CompletedLoadScrapeTargets],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const data: ReadonlyArray<V2ScrapeTarget> = yield* collectV2Pages((cursor) =>
				client.scrapeTargets.list({
					query: { limit: 100, ...(cursor !== undefined ? { cursor } : undefined) },
				}),
			)
			return data
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadScrapeTargets({ key, result })),
		),
})

/** `useIntegrationMessage`: a successful callback is the `integration_connected` product event. */
export const TrackConnected = Command.define("TrackIntegrationConnected", {
	args: { provider: Schema.String },
	messages: [Message.CompletedTrackConnected],
	execute: ({ provider }) =>
		trackProduct("integration_connected", { provider }).pipe(
			Effect.as(Message.CompletedTrackConnected()),
		),
})

/** `useIsOrgAdmin()`: the session the shell already read (`SessionTenant`), for the settings rail. */
export const LoadSession = Command.define("LoadIntegrationsSession", {
	messages: [Message.CompletedLoadSession],
	execute: Effect.map(readIsOrgAdmin, (isAdmin) => Message.CompletedLoadSession({ isAdmin })),
})

/** `useMapleCustomer` (`billingCustomerAtom`). */
export const LoadCustomer = Command.define("LoadIntegrationsCustomer", {
	args: Args,
	messages: [Message.CompletedLoadCustomer],
	execute: ({ key }) =>
		Effect.gen(function* () {
			return yield* (yield* BillingCustomerCache).get()
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedLoadCustomer({ key, result })),
		),
})
