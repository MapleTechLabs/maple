import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	lastSyncOf,
	NOT_CONFIGURED,
	NOT_CONNECTED,
	UNCONFIGURED,
	unavailableOverview,
	unavailableStatus,
} from "../../../integrations/overview"
import type { ProviderModule } from "../../../integrations/provider"
import { supabaseFlow } from "./flow-supabase"
import { initSupabaseCard, SUPABASE_STATUS_READ, type SupabaseCardModel, SupabaseMessage } from "./supabase"
import {
	clickedSync,
	isSupabaseConnected,
	requestMetricsRows,
	settledStatus,
	update,
} from "./update-supabase"
import { supabaseFlowView } from "./view-flow-supabase"
import { supabaseCard } from "./view-supabase"

// Supabase's part of `/integrations` and `/sources/new`: an organization's projects and their switches.

export const SUPABASE: ProviderModule<SupabaseIntegrationStatus, SupabaseCardModel, SupabaseMessage> = {
	id: "supabase",
	statusRead: SUPABASE_STATUS_READ,
	init: initSupabaseCard,
	update,
	onEnter: (model, env) => requestMetricsRows(model, env, "Load"),
	onClock: (model, env) => requestMetricsRows(model, env, "Load"),
	// Any answer to the current read retires saved flips; a failed one shows the last known value.
	onStatus: (model, env, { isCurrent }) =>
		requestMetricsRows(isCurrent ? settledStatus(model) : model, env, "Load"),
	// The callback no longer discovers projects; a sync now lists them instead of the hourly cron.
	onConnected: (model) => clickedSync(model),
	subscription: {
		everyMs: 60_000,
		isActive: (_model, env) => env.isShown && isSupabaseConnected(env),
		tick: SupabaseMessage.TickedClock(),
	},
	card: supabaseCard,
	flow: supabaseFlow,
	flowView: supabaseFlowView,
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				!status.configured
					? NOT_CONFIGURED
					: !status.connected
						? NOT_CONNECTED
						: status.revoked
							? { label: "Access revoked", variant: "crit" }
							: { label: status.organization?.name ?? "Connected", variant: "ok" },
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (!status.configured) return UNCONFIGURED
				if (!status.connected) return CONNECT
				const issue = status.revoked
					? "Reconnect to resume"
					: status.lastDiscoveryError !== null
						? "Project discovery failing"
						: null
				const collecting = Arr.filter(status.projects, (project) => project.metricsEnabled).length
				return {
					kind: "connected",
					...attentionOr(issue),
					context: status.organization?.name ?? null,
					stat: `${countLabel(status.projects.length, "project")} · ${collecting} collecting metrics`,
					lastSync: lastSyncOf(status.lastDiscoveryAt),
					issue,
				}
			},
			unavailableOverview,
		),
}
