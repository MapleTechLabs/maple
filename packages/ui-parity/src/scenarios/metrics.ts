import { clickButton, opsScenarios, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Metric detail pages for each seeded metric type: histogram, sum and gauge. */
const metric = opsScenarios("metrics", "Metric")

export const metricsArea: AreaModule = {
	area: "metrics",
	scenarios: [
		metric("histogram", "http.server.request.duration", "/metrics/http.server.request.duration"),
		metric(
			"histogram-filtered",
			"Request duration on payment-svc",
			"/metrics/http.server.request.duration",
			{
				steps: act(clickButton(/^Filter to service\.name = payment-svc/)),
			},
		),
		metric("sum", "shop.orders.created", "/metrics/shop.orders.created"),
		metric("gauge", "system.memory.utilization", "/metrics/system.memory.utilization"),
	],
}
