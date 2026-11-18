import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import {
	CostConnectionForbiddenError,
	CostConnectionPersistenceError,
	CostConnectionRemoved,
	CostConnectionSaved,
	CostConnectionValidationError,
} from "./cost-connections"
import { SessionAuthorization } from "./current-tenant"
import { CloudCostDisabledError } from "./query-engine"

/** Far above any Tinybird token: it only bounds what the request carries. */
export const TINYBIRD_COST_TOKEN_MAX_LENGTH = 512

/** A Tinybird token with the WORKSPACE:READ_ALL and ORG_DATASOURCES:READ scopes (p.ey...). */
export class TinybirdCostTokenRequest extends Schema.Class<TinybirdCostTokenRequest>(
	"TinybirdCostTokenRequest",
)({
	token: Schema.String.check(Schema.isMaxLength(TINYBIRD_COST_TOKEN_MAX_LENGTH)),
}) {}

/** Saving a token makes the org's Tinybird cost source, replacing one keeps it, removing deletes it. */
export class TinybirdCostApiGroup extends HttpApiGroup.make("tinybirdCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: TinybirdCostTokenRequest,
			success: CostConnectionSaved,
			error: [
				CostConnectionPersistenceError,
				CostConnectionForbiddenError,
				CostConnectionValidationError,
				CloudCostDisabledError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: CostConnectionRemoved,
			error: [CostConnectionPersistenceError, CostConnectionForbiddenError],
		}),
	)
	.prefix("/internal/cost/tinybird")
	.middleware(SessionAuthorization) {}
