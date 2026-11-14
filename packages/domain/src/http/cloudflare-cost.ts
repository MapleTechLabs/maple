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

/** Far above any Cloudflare token (about 40 to 60 characters): it only bounds what the request carries. */
export const CLOUDFLARE_COST_TOKEN_MAX_LENGTH = 256

export class CloudflareCostTokenRequest extends Schema.Class<CloudflareCostTokenRequest>(
	"CloudflareCostTokenRequest",
)({
	apiToken: Schema.String.check(Schema.isMaxLength(CLOUDFLARE_COST_TOKEN_MAX_LENGTH)),
}) {}

/** Saving a token makes the org's Cloudflare cost source, replacing one keeps it, removing deletes it. */
export class CloudflareCostApiGroup extends HttpApiGroup.make("cloudflareCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: CloudflareCostTokenRequest,
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
	.prefix("/internal/cost/cloudflare")
	.middleware(SessionAuthorization) {}
