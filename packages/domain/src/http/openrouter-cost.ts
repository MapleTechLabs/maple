import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import {
	OpenRouterKeyForbiddenError,
	OpenRouterKeyPersistenceError,
	OpenRouterKeyUpdateRequest,
	OpenRouterKeyValidationError,
} from "./openrouter-key"
import { CloudCostDisabledError } from "./query-engine"

/** The saved management key never comes back: `keyLabel` is how OpenRouter masks it. */
export class OpenRouterCostKeySaved extends Schema.Class<OpenRouterCostKeySaved>("OpenRouterCostKeySaved")({
	keyLabel: Schema.String,
}) {}

export class OpenRouterCostKeyRemoved extends Schema.Class<OpenRouterCostKeyRemoved>(
	"OpenRouterCostKeyRemoved",
)({
	removed: Schema.Boolean,
}) {}

/** Saving a key makes the org's OpenRouter cost source, replacing one keeps it, removing deletes it. */
export class OpenRouterCostApiGroup extends HttpApiGroup.make("openRouterCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: OpenRouterKeyUpdateRequest,
			success: OpenRouterCostKeySaved,
			error: [
				OpenRouterKeyPersistenceError,
				OpenRouterKeyForbiddenError,
				OpenRouterKeyValidationError,
				CloudCostDisabledError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: OpenRouterCostKeyRemoved,
			error: [OpenRouterKeyPersistenceError, OpenRouterKeyForbiddenError],
		}),
	)
	.prefix("/internal/cost/openrouter")
	.middleware(SessionAuthorization) {}
