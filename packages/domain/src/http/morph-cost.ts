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
import { EndpointAccess, handler } from "./endpoint-access"

/** Far above any Morph key: it only bounds what the request carries. */
export const MORPH_COST_KEY_MAX_LENGTH = 512

/** A Morph API key (sk-...) of an organization, owned by one of its admins. */
export class MorphCostKeyRequest extends Schema.Class<MorphCostKeyRequest>("MorphCostKeyRequest")({
	apiKey: Schema.String.check(Schema.isMaxLength(MORPH_COST_KEY_MAX_LENGTH)),
}) {}

/** Saving a key makes the org's Morph cost source, replacing one keeps it, removing deletes it. */
export class MorphCostApiGroup extends HttpApiGroup.make("morphCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: MorphCostKeyRequest,
			success: CostConnectionSaved,
			error: [
				CostConnectionPersistenceError,
				CostConnectionForbiddenError,
				CostConnectionValidationError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: CostConnectionRemoved,
			error: [CostConnectionPersistenceError, CostConnectionForbiddenError],
		}),
	)
	.prefix("/internal/cost/morph")
	.middleware(SessionAuthorization)
	// `saveCostConnection` / `removeCostConnection` check `integrations:manage`.
	.annotate(EndpointAccess, handler("integrations:manage")) {}
