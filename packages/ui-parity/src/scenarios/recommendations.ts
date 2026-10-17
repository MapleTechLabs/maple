import { opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Instrumentation recommendations the reconciler found in Acme's spans. */
const recommendation = opsScenarios("recommendations", "Recommendations")

export const recommendationsArea: AreaModule = {
	area: "recommendations",
	scenarios: [
		recommendation(
			"double-emission",
			"deployment.environment emitted twice",
			`/recommendations/${SEEDED.doubleEmissionRecommendation}`,
		),
		recommendation(
			"rename",
			"peer.service is deprecated",
			`/recommendations/${SEEDED.renameRecommendation}`,
		),
		recommendation("not-found", "Unknown recommendation", "/recommendations/0199a062-0000-7000-8000-0000000000ff"),
	],
}
