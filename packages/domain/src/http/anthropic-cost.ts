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
export const ANTHROPIC_COST_KEY_MAX_LENGTH = 512

/** An Anthropic Admin API key (sk-ant-admin...). */
export class AnthropicCostKeyRequest extends Schema.Class<AnthropicCostKeyRequest>("AnthropicCostKeyRequest")(
	{
		apiKey: Schema.String.check(Schema.isMaxLength(ANTHROPIC_COST_KEY_MAX_LENGTH)),
	},
) {}

/** Saving a key makes the org's Anthropic cost source, replacing one keeps it, removing deletes it. */
export class AnthropicCostApiGroup extends HttpApiGroup.make("anthropicCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: AnthropicCostKeyRequest,
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
	.prefix("/internal/cost/anthropic")
	.middleware(SessionAuthorization) {}
