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

/** Far above any admin key: it only bounds what the request carries. */
export const OPENAI_COST_KEY_MAX_LENGTH = 512

/** An OpenAI Admin API key (sk-admin-...). */
export class OpenAiCostKeyRequest extends Schema.Class<OpenAiCostKeyRequest>("OpenAiCostKeyRequest")({
	apiKey: Schema.String.check(Schema.isMaxLength(OPENAI_COST_KEY_MAX_LENGTH)),
}) {}

/** Saving a key makes the org's OpenAI cost source, replacing one keeps it, removing deletes it. */
export class OpenAiCostApiGroup extends HttpApiGroup.make("openaiCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: OpenAiCostKeyRequest,
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
	.prefix("/internal/cost/openai")
	.middleware(SessionAuthorization) {}
