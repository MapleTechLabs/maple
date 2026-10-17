import { clickButton, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/**
 * Dashboards built from the API's templates: stat, table, chart and list widgets, the builder in
 * edit mode, one widget's editor, and the template gallery.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`

export const dashboardsArea: AreaModule = {
	area: "dashboards",
	scenarios: [
		dashboard("list", "List with template-built boards", "/dashboards"),
		dashboard("platform", "Platform overview (stat, table, chart, list)", platform, { fullPage: true }),
		dashboard("payment", "Payment service health", `/dashboards/${SEEDED.paymentDashboard}`),
		dashboard("edit", "Platform overview in edit mode", platform, {
			steps: act(clickButton("Edit dashboard")),
		}),
		dashboard("widget", "Throughput chart widget editor", `${platform}/widgets/throughput-by-service`),
		dashboard("templates", "Template gallery", "/dashboards/templates"),
		dashboard("template-preview", "Service Health template preview", "/dashboards/templates", {
			steps: act(clickButton(/^Service Health/)),
		}),
		dashboard("list-empty", "Dashboards (empty org)", "/dashboards", { dataset: EMPTY }),
	],
}
