import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import {
	IntegrationsConnectionChangedError,
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
} from "./integrations"
import { CloudCostDisabledError } from "./query-engine"

/** The Vercel team the org's connection reads, as the Cost page names it. */
export const VercelCostTeam = Schema.Struct({ name: Schema.String, slug: Schema.String })
export type VercelCostTeam = typeof VercelCostTeam.Type

/** What the Cost page needs to offer Vercel: the connected team, if any, and whether it is a source. */
export class VercelCostStatus extends Schema.Class<VercelCostStatus>("VercelCostStatus")({
	/** Null when the org has no Vercel connection. */
	team: Schema.NullOr(VercelCostTeam),
	/** Vercel rejected the stored token: the team has to be connected again before it can supply cost. */
	authFailed: Schema.Boolean,
	/** The team is a cost source already. */
	added: Schema.Boolean,
}) {}

export class VercelCostSourceAdded extends Schema.Class<VercelCostSourceAdded>("VercelCostSourceAdded")({
	team: VercelCostTeam,
}) {}

export class VercelCostSourceRemoved extends Schema.Class<VercelCostSourceRemoved>("VercelCostSourceRemoved")(
	{
		/** False when there was no Vercel source to remove. */
		removed: Schema.Boolean,
	},
) {}

/** The org's Vercel team as a cost source: adding makes the source, removing deletes it. */
export class VercelCostApiGroup extends HttpApiGroup.make("vercelCost")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: VercelCostStatus,
			error: [IntegrationsPersistenceError, CloudCostDisabledError],
		}),
	)
	.add(
		HttpApiEndpoint.put("add", "/", {
			success: VercelCostSourceAdded,
			error: [
				IntegrationsPersistenceError,
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsConnectionChangedError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				CloudCostDisabledError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: VercelCostSourceRemoved,
			error: [IntegrationsPersistenceError, IntegrationsForbiddenError],
		}),
	)
	.prefix("/internal/cost/vercel")
	.middleware(SessionAuthorization) {}
