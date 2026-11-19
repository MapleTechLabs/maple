import type { FleetIntegrationStatus } from "@maple/domain/http"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	lastSyncOf,
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "../overview"
import type { ProviderModule } from "../provider"
import { FLEET_STATUS_READ, type FleetCardModel, FleetMessage, fleetNameOf, initFleetCard } from "./fleet"
import { onStatus, update } from "./update-fleet"
import { fleetCard } from "./view-fleet"

// Fleet's part of `/integrations`: a URL and token, then the server's identity and sync state.

const issueOf = (status: FleetIntegrationStatus): string | null =>
	status.authFailed ? "Token rejected" : status.lastError !== null ? "Sync failing" : null

export const FLEET: ProviderModule<FleetIntegrationStatus, FleetCardModel, FleetMessage> = {
	id: "fleet",
	statusRead: FLEET_STATUS_READ,
	init: initFleetCard,
	update,
	onStatus: (model, env) => onStatus(model, env),
	card: (h, model, timeZone) => [fleetCard(h, model, timeZone)],
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				!status.connected
					? NOT_CONNECTED
					: status.authFailed
						? { label: "Token rejected", variant: "crit" }
						: status.lastError !== null
							? { label: "Needs attention", variant: "warn" }
							: { label: "Connected", variant: "ok" },
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (!status.connected) return CONNECT
				const issue = issueOf(status)
				return {
					kind: "connected",
					...attentionOr(issue),
					context: fleetNameOf(status),
					stat: status.serverVersion !== null ? `Fleet ${status.serverVersion}` : null,
					lastSync: lastSyncOf(status.lastSyncedAt),
					issue,
				}
			},
			unavailableOverview,
		),
}
