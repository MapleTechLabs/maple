import type { RunCostEstimator } from "@yielded/agent/run-options"
import { Effect } from "effect"
import { reportedCostOf } from "./genai-spans"

/**
 * OpenRouter's own price for each call, the provider's upstream price included on a BYOK key;
 * Maple never prices tokens itself. A call without one
 * (Workers AI, or a response that carried no cost) is `unknown`, never free.
 */
export const reportedCost: RunCostEstimator = (request) => {
	const cost = reportedCostOf(request.finishMetadata)
	return Effect.succeed(
		cost === undefined
			? { costMicrousd: 0, pricingStatus: "unknown" as const }
			: { costMicrousd: Math.round(cost * 1_000_000), pricingStatus: "estimated" as const },
	)
}
