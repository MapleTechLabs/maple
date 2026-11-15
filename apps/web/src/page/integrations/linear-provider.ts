import type { LinearIntegrationStatus } from "@maple/domain/http"
import { Effect } from "effect"
import { MapleInternalApiClient } from "../../platform/api-clients"
import {
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "./overview"
import { initLinearCard, type LinearCardModel, type LinearMessage } from "./linear"
import type { ProviderModule } from "./provider"
import { statusAnswered, update } from "./update-linear"
import { linearCard } from "./view-linear"

// Linear's part of `/integrations`: the OAuth grant incidents open issues with. Connect and
// disconnect are the hub's; the module owns the feature switches.

/** The hub's status read for Linear. */
export const LINEAR_STATUS_READ = {
	name: "LoadIntegrationsLinearStatus",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.integrations.linearStatus()),
}

export const LINEAR: ProviderModule<LinearIntegrationStatus, LinearCardModel, LinearMessage> = {
	id: "linear",
	statusRead: LINEAR_STATUS_READ,
	init: initLinearCard,
	update,
	onStatus: statusAnswered,
	card: (h, model) => [linearCard(h, model)],
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				status.revoked
					? { label: "Revoked", variant: "warn" }
					: status.connected
						? {
								label:
									status.workspaceName === null || status.workspaceName === ""
										? "Connected"
										: status.workspaceName,
								variant: "ok",
							}
						: NOT_CONNECTED,
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview =>
				status.revoked
					? {
							kind: "connected",
							health: "attention",
							stateLabel: "Revoked",
							context: status.workspaceName,
							stat: null,
							lastSync: null,
							issue: "Reconnect Linear",
						}
					: status.connected
						? {
								kind: "connected",
								health: "healthy",
								stateLabel: "Healthy",
								context: status.workspaceName,
								stat: "Incident issues ready",
								lastSync: null,
								issue: null,
							}
						: CONNECT,
			unavailableOverview,
		),
}
