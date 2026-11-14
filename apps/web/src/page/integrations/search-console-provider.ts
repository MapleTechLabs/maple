import type { SearchConsoleIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	lastSyncOf,
	maxMs,
	NOT_CONFIGURED,
	NOT_CONNECTED,
	UNCONFIGURED,
	unavailableOverview,
	unavailableStatus,
} from "./overview"
import type { ProviderModule } from "./provider"
import {
	initSearchConsoleCard,
	SEARCH_CONSOLE_STATUS_READ,
	type SearchConsoleCardModel,
	type SearchConsoleMessage,
} from "./search-console"
import { requestSites, statusAnswered, update } from "./update-search-console"
import { searchConsoleCard } from "./view-search-console"

// Google Search Console's part of `/integrations`: the Google grant and the properties it imports.

export const SEARCH_CONSOLE: ProviderModule<
	SearchConsoleIntegrationStatus,
	SearchConsoleCardModel,
	SearchConsoleMessage
> = {
	id: "google-search-console",
	statusRead: SEARCH_CONSOLE_STATUS_READ,
	init: initSearchConsoleCard,
	update,
	onEnter: (model, env) => requestSites(model, env, "Load"),
	onStatus: statusAnswered,
	// A reconnect as the same account keeps the grant key, so its property list is re-read outright.
	onConnected: (model, env) => requestSites(model, env, "Supersede"),
	onRelayedConnect: (model, env) => requestSites(model, env, "Supersede"),
	card: (h, model) => searchConsoleCard(h, model),
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus =>
				status.revoked
					? { label: "Revoked", variant: "warn" }
					: !status.connected
						? status.configured
							? NOT_CONNECTED
							: NOT_CONFIGURED
						: {
								label: countLabel(
									Arr.filter(status.sites, (site) => site.enabled).length,
									"property",
									"properties",
								),
								variant: "ok",
							},
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				if (!status.connected) return status.configured ? CONNECT : UNCONFIGURED
				const enabled = Arr.filter(status.sites, (site) => site.enabled)
				const failing = Arr.filter(enabled, (site) => site.lastError !== null).length
				const issue = status.revoked
					? "Reconnect Google"
					: enabled.length === 0
						? "Choose properties"
						: failing > 0
							? `${countLabel(failing, "property", "properties")} failing`
							: null
				return {
					kind: "connected",
					...attentionOr(issue),
					...(status.revoked ? { stateLabel: "Revoked" } : undefined),
					context: status.accountEmail,
					stat:
						enabled.length > 0
							? `${countLabel(enabled.length, "property", "properties")} selected`
							: null,
					lastSync: lastSyncOf(maxMs(Arr.map(enabled, (site) => site.lastSyncedAt))),
					issue,
				}
			},
			unavailableOverview,
		),
}
