import type { VercelIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import {
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
import { update } from "./update-vercel"
import {
	initVercelCard,
	isVercelSettling,
	VERCEL_SETTLING_REFRESH_MS,
	VERCEL_STATUS_READ,
	VercelMessage,
} from "./vercel"
import { scopeLabel, signalsLabel, vercelHealth, vercelIssues } from "./vercel-model"
import type { VercelCardModel } from "./vercel-schema"
import { vercelCard, vercelHeaderActions, vercelHeaderStatus } from "./view-vercel"

// Vercel's part of `/integrations`: a team token, the drains it creates and the configure dialog.

const STATE_LABEL = { attention: "Needs attention", pending: "Syncing", healthy: "Healthy" } as const

export const VERCEL: ProviderModule<VercelIntegrationStatus, VercelCardModel, VercelMessage> = {
	id: "vercel",
	statusRead: VERCEL_STATUS_READ,
	init: initVercelCard,
	update,
	// Re-reads the status (and the clock that ends the window) while a fresh connection settles.
	subscription: {
		everyMs: VERCEL_SETTLING_REFRESH_MS,
		isActive: (_model, env) =>
			env.isShown &&
			Option.exists(AsyncData.getData(env.status.data), (status) =>
				isVercelSettling(status, env.nowMs),
			),
		tick: VercelMessage.TickedSettle(),
	},
	card: vercelCard,
	headerActions: vercelHeaderActions,
	headerStatus: vercelHeaderStatus,
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				!status.connected
					? NOT_CONNECTED
					: status.authFailed
						? { label: "Token rejected", variant: "crit" }
						: vercelIssues(status).length > 0
							? { label: "Needs attention", variant: "warn" }
							: { label: status.team?.name ?? "Connected", variant: "ok" },
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (!status.connected) return CONNECT
				const issues = vercelIssues(status)
				const health = vercelHealth(status)
				return {
					kind: "connected",
					health,
					stateLabel: STATE_LABEL[health],
					context: status.team?.name ?? null,
					stat: `${signalsLabel(status)} · ${scopeLabel(status)}`,
					lastSync: lastSyncOf(status.lastSuccessAt, "checked"),
					issue: status.authFailed
						? "Token rejected"
						: issues.length > 0
							? `${countLabel(issues.length, "drain")} failing`
							: null,
				}
			},
			unavailableOverview,
		),
}
