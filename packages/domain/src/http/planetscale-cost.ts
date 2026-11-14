import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import {
	IntegrationsConnectionChangedError,
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
} from "./integrations"
import { CloudCostDisabledError } from "./query-engine"

/** What the Cost page needs to offer PlanetScale: the connected organization, if any, and whether it is a source. */
export class PlanetScaleCostStatus extends Schema.Class<PlanetScaleCostStatus>("PlanetScaleCostStatus")({
	/** The organization the org's PlanetScale connection is bound to. Null without a connection. */
	organization: Schema.NullOr(Schema.String),
	/** The stored authorization can read invoices. False for a grant made before Maple asked for them, or a revoked one. */
	invoiceAccess: Schema.Boolean,
	/** The organization is a cost source already. */
	added: Schema.Boolean,
}) {}

/** The organization the dialog showed: an add of a connection bound to another one since is refused. */
export class PlanetScaleCostAddRequest extends Schema.Class<PlanetScaleCostAddRequest>(
	"PlanetScaleCostAddRequest",
)({
	organization: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}) {}

export class PlanetScaleCostSourceAdded extends Schema.Class<PlanetScaleCostSourceAdded>(
	"PlanetScaleCostSourceAdded",
)({
	organization: Schema.String,
}) {}

export class PlanetScaleCostSourceRemoved extends Schema.Class<PlanetScaleCostSourceRemoved>(
	"PlanetScaleCostSourceRemoved",
)({
	/** False when there was no PlanetScale source to remove. */
	removed: Schema.Boolean,
}) {}

/** The code the Cost page keys its reconnect link on. */
export const PLANETSCALE_COST_RECONNECT_CODE = "planetscale_cost_reconnect_required"

/**
 * The org's PlanetScale authorization cannot read invoices: it was made before Maple asked for
 * them, or PlanetScale no longer accepts it. Only connecting PlanetScale again fixes it.
 */
export class PlanetScaleCostReconnectRequiredError extends HttpTaggedError<PlanetScaleCostReconnectRequiredError>()(
	"@maple/http/planetscale-cost/PlanetScaleCostReconnectRequiredError",
	{ message: Schema.String },
	{
		status: 409,
		code: PLANETSCALE_COST_RECONNECT_CODE,
		title: "Reconnect PlanetScale",
		retry: "never",
		recovery: "reconnect",
		exposure: "public_message",
	},
) {}

/**
 * PlanetScale did not answer the check an add makes, or answered what Maple cannot read. The
 * message is one of Maple's own sentences about that, so the Cost page shows it as it is.
 */
export class PlanetScaleCostUnavailableError extends HttpTaggedError<PlanetScaleCostUnavailableError>()(
	"@maple/http/planetscale-cost/PlanetScaleCostUnavailableError",
	{ message: Schema.String },
	{
		status: 502,
		code: "planetscale_cost_unavailable",
		title: "PlanetScale could not be read",
		retry: "backoff",
		recovery: "retry",
		exposure: "public_message",
	},
) {}

/** The org's PlanetScale organization as a cost source: adding makes the source, removing deletes it. */
export class PlanetScaleCostApiGroup extends HttpApiGroup.make("planetScaleCost")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: PlanetScaleCostStatus,
			error: [IntegrationsPersistenceError, CloudCostDisabledError],
		}),
	)
	.add(
		HttpApiEndpoint.put("add", "/", {
			payload: PlanetScaleCostAddRequest,
			success: PlanetScaleCostSourceAdded,
			error: [
				IntegrationsPersistenceError,
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsConnectionChangedError,
				PlanetScaleCostReconnectRequiredError,
				PlanetScaleCostUnavailableError,
				CloudCostDisabledError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: PlanetScaleCostSourceRemoved,
			error: [IntegrationsPersistenceError, IntegrationsForbiddenError],
		}),
	)
	.prefix("/internal/cost/planetscale")
	.middleware(SessionAuthorization) {}
