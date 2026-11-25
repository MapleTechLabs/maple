import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import type { IntegrationId } from "./catalog"
import { prometheusFlow, type ScrapeIntegration } from "./flow-prometheus"
import { SET_UP } from "./overview"
import {
	initPrometheusCard,
	type PrometheusCardModel,
	PrometheusMessage,
	SCRAPE_TARGETS_STATUS_READ,
} from "./prometheus"
import type { ProviderModule } from "./provider"
import { scrapeOverview, scrapeStatus } from "./scrape-overview"
import { update } from "./update-prometheus"
import { prometheusFlowView } from "./view-flow-prometheus"
import { scrapeIntro, scrapeTargetsSection } from "./view-prometheus"

// Prometheus and WarpStream's part of `/integrations` and `/sources/new`: scrape targets, their
// checks and the add/edit form. WarpStream clusters are scraped as Prometheus targets.

const scrapeIntegrationOf = (id: IntegrationId): ScrapeIntegration =>
	id === "warpstream" ? "warpstream" : "prometheus"

export const PROMETHEUS: ProviderModule<
	ReadonlyArray<V2ScrapeTarget>,
	PrometheusCardModel,
	PrometheusMessage
> = {
	id: "prometheus",
	owns: (id) => id === "prometheus" || id === "warpstream",
	statusRead: SCRAPE_TARGETS_STATUS_READ,
	init: initPrometheusCard,
	update,
	subscriptions: [
		{
			everyMs: 30_000,
			isActive: (_model, env) => env.isShown,
			tick: PrometheusMessage.TickedTargetsRefresh(),
		},
		// The selected target's checks; a new selection starts the 10 s over.
		{
			everyMs: 10_000,
			isActive: (model, env) => env.isShown && model.selectedId !== null,
			restartKey: (model) => model.selectedId ?? "",
			tick: PrometheusMessage.TickedChecksRefresh(),
		},
	],
	card: (h, model, timeZone, focusId, integration) => {
		const page = scrapeIntegrationOf(integration)
		return focusId === null
			? [scrapeIntro(h, page), ...scrapeTargetsSection(h, model, timeZone, null, page)]
			: scrapeTargetsSection(h, model, timeZone, focusId, page)
	},
	flow: (model, integration, context) => prometheusFlow(model, scrapeIntegrationOf(integration), context),
	flowView: (h, model, stage, timeZone, integration) =>
		prometheusFlowView(h, model, scrapeIntegrationOf(integration), stage, timeZone),
	cardStatus: (_slot, { id, statuses }) =>
		id === "warpstream"
			? { label: "Via Prometheus", variant: "outline" }
			: scrapeStatus(statuses, "prometheus"),
	overview: (_slot, { id, statuses }) =>
		id === "warpstream" ? SET_UP : scrapeOverview(statuses, "prometheus"),
}
