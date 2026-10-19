import { clickButton, clickTab, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** The payment-svc pool-timeout trace in each of its views, and with its root span open. */
const trace = opsScenarios("traces", "Trace")
const path = `/traces/${SEEDED.poolTimeoutTrace}`

export const tracesArea: AreaModule = {
	area: "traces",
	scenarios: [
		trace("waterfall", "Waterfall view", path, { steps: act(clickTab("Waterfall")) }),
		trace("flow", "Flow view", path, { steps: act(clickTab("Flow")) }),
		trace("span", "Root span detail", path, { steps: act(clickButton("View span")) }),
	],
}
