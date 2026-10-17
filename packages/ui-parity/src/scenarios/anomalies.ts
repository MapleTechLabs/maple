import { clickTab, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Anomaly incidents: payment-svc latency and error rate open, a catalog-api dip resolved. */
const anomaly = opsScenarios("anomalies", "Anomalies")

export const anomaliesArea: AreaModule = {
	area: "anomalies",
	scenarios: [
		anomaly("list", "Open anomalies", "/anomalies"),
		anomaly("list-all", "All anomalies", "/anomalies", { steps: act(clickTab("All")) }),
		anomaly("detail", "payment-svc p95 latency", `/anomalies/${SEEDED.latencyAnomaly}`),
		anomaly("list-empty", "Anomalies (empty org)", "/anomalies", { dataset: EMPTY }),
	],
}
