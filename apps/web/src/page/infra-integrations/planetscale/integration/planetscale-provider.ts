import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import {
	attentionOr,
	type CardStatus,
	fold,
	type IntegrationOverview,
	isoMs,
	lastSyncOf,
	maxMs,
	unavailableOverview,
	unavailableStatus,
} from "../../../integrations/overview"
import type { ProviderModule } from "../../../integrations/provider"
import { scrapeOverview, scrapeStatus } from "../../../integrations/scrape-overview"
import { metricsAuthOf, metricsLastCollectedAt, metricsLastError } from "../setup-steps"
import { planetscaleFlow } from "./flow-planetscale"
import {
	initPlanetscaleCard,
	isWatchExpired,
	PLANETSCALE_STATUS_READ,
	type PlanetscaleCardModel,
	PlanetscaleMessage,
} from "./planetscale"
import {
	enterPlanetscale,
	isAwaiting,
	restartWatch,
	statusAnswered,
	update,
	withWatchStart,
} from "./update-planetscale"
import { planetscaleFlowView } from "./view-flow-planetscale"
import { planetscaleCard } from "./view-planetscale"

// PlanetScale's part of `/integrations` and `/sources/new`: the OAuth grant, the organization
// picker, branch metrics (API or service token) and the watch for the first metrics.

export const PLANETSCALE: ProviderModule<V2PlanetScaleIntegration, PlanetscaleCardModel, PlanetscaleMessage> =
	{
		id: "planetscale",
		statusRead: PLANETSCALE_STATUS_READ,
		init: initPlanetscaleCard,
		update,
		onEnter: enterPlanetscale,
		onClock: (model, env) => ({ model: withWatchStart(model, env, env.nowMs) }),
		onStatus: statusAnswered,
		onConnected: restartWatch,
		onRelayedConnect: restartWatch,
		// Watches for the first metrics; the card offers "Check again" once the watch runs out.
		subscription: {
			everyMs: 60_000,
			fast: { everyMs: 5_000, ticks: 24 },
			isActive: (model, env) => isAwaiting(env) && !isWatchExpired(model, env.nowMs),
			tick: PlanetscaleMessage.TickedWatch(),
		},
		card: (h, model, timeZone) => [planetscaleCard(h, model, timeZone)],
		flow: planetscaleFlow,
		flowView: (h, model, stage) => planetscaleFlowView(h, model, stage),
		cardStatus: (slot, { statuses }) =>
			fold(
				slot,
				(status): CardStatus | null =>
					status.connected
						? {
								label: status.organization ?? "Connected",
								variant: metricsLastError(status) !== null ? "warn" : "ok",
							}
						: scrapeStatus(statuses, "planetscale"),
				unavailableStatus,
			),
		overview: (slot, { statuses }) => {
			const dbCount = fold(
				statuses.planetscaleDatabases,
				(response): number | null => response.databases.length,
				() => null,
			)
			return fold(
				slot,
				(status): IntegrationOverview => {
					if (!status.connected) return scrapeOverview(statuses, "planetscale")
					const issue = status.pending_org_selection
						? "Finish org selection"
						: metricsLastError(status) !== null
							? metricsAuthOf(status) === "api"
								? "Metrics polling failing"
								: "Scrape failing"
							: status.last_inventory_error != null
								? "Inventory failing"
								: null
					return {
						kind: "connected",
						...attentionOr(issue),
						context: status.organization,
						stat:
							dbCount !== null && dbCount > 0
								? `${countLabel(dbCount, "database")} tracked`
								: metricsAuthOf(status) === "api" || status.scrape_target?.enabled === true
									? "Branch metrics on"
									: null,
						lastSync: lastSyncOf(
							maxMs(Arr.map([metricsLastCollectedAt(status), status.last_inventory_at], isoMs)),
						),
						issue,
					}
				},
				unavailableOverview,
			)
		},
	}
