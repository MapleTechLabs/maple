import type { RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
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
} from "../../../integrations/overview"
import type { ProviderModule } from "../../../integrations/provider"
import { railwayFlow } from "./flow-railway"
import {
	initRailwayCard,
	RAILWAY_STATUS_READ,
	type RailwayCardModel,
	RailwayMessage,
	unsyncedEnvironments,
} from "./railway"
import { update } from "./update-railway"
import { railwayFlowView } from "./view-flow-railway"
import { railwayCard } from "./view-railway"

// Railway's part of `/integrations` and `/sources/new`: a token, then its environments.

export const RAILWAY: ProviderModule<RailwayIntegrationStatus, RailwayCardModel, RailwayMessage> = {
	id: "railway",
	statusRead: RAILWAY_STATUS_READ,
	init: initRailwayCard,
	update,
	subscription: {
		everyMs: 15_000,
		isActive: (_model, env) => {
			const status = Option.getOrNull(AsyncData.getData(env.status.data))
			return (
				env.isShown &&
				status !== null &&
				status.connected &&
				!status.authFailed &&
				unsyncedEnvironments(status) > 0
			)
		},
		tick: RailwayMessage.TickedSettle(),
	},
	card: railwayCard,
	flow: railwayFlow,
	flowView: railwayFlowView,
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				!status.connected
					? NOT_CONNECTED
					: status.authFailed
						? { label: "Token rejected", variant: "crit" }
						: { label: countLabel(status.environments.length, "environment"), variant: "ok" },
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (!status.connected) return CONNECT
				const failing = Arr.filter(
					status.environments,
					(environment) => environment.lastError != null,
				).length
				const issue = status.authFailed
					? "Token rejected"
					: failing > 0
						? `${countLabel(failing, "environment")} failing`
						: null
				return {
					kind: "connected",
					...attentionOr(issue),
					context: status.workspaceNames,
					stat: `${countLabel(status.environments.length, "environment")} polled`,
					lastSync: lastSyncOf(status.lastSyncedAt ?? null),
					issue,
				}
			},
			unavailableOverview,
		),
}
