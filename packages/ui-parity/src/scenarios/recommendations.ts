import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Instrumentation recommendations the reconciler found in Acme's spans. */
const recommendation = opsScenarios("recommendations", "Recommendations")
const rename = `/recommendations/${SEEDED.renameRecommendation}`
const doubleEmission = `/recommendations/${SEEDED.doubleEmissionRecommendation}`

const waitForText = (text: string | RegExp) => (page: Page) =>
	page.getByText(text).first().waitFor({ state: "visible" })

const failing = {
	faults: {
		failures: {
			"instrumentationRecommendations.list": {
				status: 500,
				body: {
					_tag: "@maple/http/errors/RecommendationIssuePersistenceError",
					message: "ui-parity: injected recommendations failure",
				},
			},
		},
	},
}

export const recommendationsArea: AreaModule = {
	area: "recommendations",
	scenarios: [
		recommendation("double-emission", "deployment.environment emitted twice", doubleEmission),
		recommendation("rename", "peer.service is deprecated", rename),
		recommendation("not-found", "Unknown recommendation", "/recommendations/0199a062-0000-7000-8000-0000000000ff"),
		recommendation("rename-loading", "Rename, list held", rename, {
			faults: { delays: { "instrumentationRecommendations.list": 60_000 } },
			settle: "held",
		}),
		recommendation("rename-error", "Rename, list failing", rename, failing),
		recommendation("rename-apply", "Rename, apply the mapping", rename, {
			steps: act(clickButton("Apply mapping"), waitForText(/^Mapping created/)),
		}),
		recommendation("rename-dismiss", "Rename, dismiss it", rename, {
			steps: act(clickButton("Dismiss recommendation")),
		}),
		recommendation("double-emission-dismiss", "Double emission, dismiss it", doubleEmission, {
			steps: act(clickButton("Dismiss recommendation")),
		}),
		recommendation("rename-copy", "Rename, copy the mapping", rename, {
			steps: act(clickButton("Copy Mapping")),
		}),
	],
}
