/** Output schema for the list_integrations MCP tool. */
import { Schema } from "effect"
import { INTEGRATION_PROVIDERS, INTEGRATION_STATUSES } from "../integration-inventory"

export const IntegrationProviderLiteral = Schema.Literals(INTEGRATION_PROVIDERS)
export const IntegrationStatusLiteral = Schema.Literals(INTEGRATION_STATUSES)

export const IntegrationResourceRow = Schema.Struct({
	/** repository, zone, workers, logpush, hyperdrive, environment, database, scrape target, workspace. */
	kind: Schema.String,
	name: Schema.String,
	status: IntegrationStatusLiteral,
	lastSuccessAt: Schema.NullOr(Schema.String),
	lastError: Schema.NullOr(Schema.String),
	note: Schema.NullOr(Schema.String),
})

export const IntegrationRow = Schema.Struct({
	provider: IntegrationProviderLiteral,
	status: IntegrationStatusLiteral,
	account: Schema.NullOr(Schema.String),
	connectedAt: Schema.NullOr(Schema.String),
	/** Why the provider is not healthy; null when it is. */
	problem: Schema.NullOr(Schema.String),
	feeds: Schema.Array(Schema.String),
	/** Resources shown, worst first; capped, so `resourceCount` can be larger. */
	resources: Schema.Array(IntegrationResourceRow),
	resourceCount: Schema.Number,
	/** Resources that are not healthy, of `resourceCount`. */
	unhealthyCount: Schema.Number,
})

export const ListIntegrationsOutput = Schema.Struct({
	generatedAt: Schema.String,
	integrations: Schema.Array(IntegrationRow),
	/** Providers with nothing connected, and what connecting them feeds. */
	available: Schema.Array(
		Schema.Struct({ provider: IntegrationProviderLiteral, feeds: Schema.Array(Schema.String) }),
	),
	/** The provider the call was narrowed to, which decides how much the text lists. */
	providerFilter: Schema.optionalKey(IntegrationProviderLiteral),
})

// ---------------------------------------------------------------------------------------------
// sync_railway

export const SyncRailwayOutput = Schema.Struct({
	connected: Schema.Boolean,
	/** Railway rejected the stored token; polling is paused until a new one is saved. */
	authFailed: Schema.Boolean,
	lastSyncedAt: Schema.NullOr(Schema.String),
	lastError: Schema.NullOr(Schema.String),
	environments: Schema.Array(
		Schema.Struct({
			project: Schema.String,
			environment: Schema.String,
			services: Schema.Number,
			lastSyncedAt: Schema.NullOr(Schema.String),
			lastError: Schema.NullOr(Schema.String),
			/** Still no successful poll in the last 30 minutes after this sync: Railway returned nothing for it. */
			stale: Schema.Boolean,
		}),
	),
})

// ---------------------------------------------------------------------------------------------
// create_scrape_target / update_scrape_target / delete_scrape_target

export const ScrapeTargetRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	url: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	scrapeIntervalSeconds: Schema.Number,
	enabled: Schema.Boolean,
	authType: Schema.String,
	lastScrapeAt: Schema.NullOr(Schema.String),
	lastScrapeError: Schema.NullOr(Schema.String),
})

export const ScrapeTargetMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated"]),
	target: ScrapeTargetRow,
})

export const DeleteScrapeTargetOutput = Schema.Struct({
	deleted: Schema.Boolean,
	id: Schema.String,
	name: Schema.String,
})
