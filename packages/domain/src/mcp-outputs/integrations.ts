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
