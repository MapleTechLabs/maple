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

/** An organization's name in PlanetScale's URLs. Longer than any PlanetScale allows. */
export const PLANETSCALE_COST_ORGANIZATION_MAX_LENGTH = 100
/** A service token's ID is 12 characters and the token about 54; anything much longer is neither. */
export const PLANETSCALE_COST_TOKEN_ID_MAX_LENGTH = 64
export const PLANETSCALE_COST_TOKEN_MAX_LENGTH = 256

/** A service token is two values: PlanetScale shows its ID and, once, the token. */
export class PlanetScaleCostTokenRequest extends Schema.Class<PlanetScaleCostTokenRequest>(
	"PlanetScaleCostTokenRequest",
)({
	organization: Schema.String.check(Schema.isMaxLength(PLANETSCALE_COST_ORGANIZATION_MAX_LENGTH)),
	tokenId: Schema.String.check(Schema.isMaxLength(PLANETSCALE_COST_TOKEN_ID_MAX_LENGTH)),
	token: Schema.String.check(Schema.isMaxLength(PLANETSCALE_COST_TOKEN_MAX_LENGTH)),
}) {}

/** Saving a token makes the org's PlanetScale cost source, replacing one keeps it, removing deletes it. */
export class PlanetScaleCostApiGroup extends HttpApiGroup.make("planetScaleCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: PlanetScaleCostTokenRequest,
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
	.prefix("/internal/cost/planetscale")
	.middleware(SessionAuthorization) {}
