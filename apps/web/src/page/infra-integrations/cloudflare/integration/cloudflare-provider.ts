import type { CloudflareIntegrationStatus } from "@maple/domain/http"
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
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "../../../integrations/overview"
import type { ProviderModule } from "../../../integrations/provider"
import {
	CLOUDFLARE_STATUS_READ,
	type CloudflareCardModel,
	CloudflareMessage,
	initCloudflareCard,
} from "./cloudflare"
import { cloudflareFlow } from "./flow-cloudflare"
import {
	enterCloudflare,
	isSettling,
	prime,
	refreshCloudflare,
	requestUsage,
	resetPrime,
	update,
} from "./update-cloudflare"
import { cloudflareCard, cloudflareHeaderActions } from "./view-cloudflare"
import { cloudflareFlowView } from "./view-flow-cloudflare"

// Cloudflare's part of `/integrations` and `/sources/new`: the OAuth grant, its prime, the zone
// board and Workers card, and "Manage zones".

export const CLOUDFLARE: ProviderModule<CloudflareIntegrationStatus, CloudflareCardModel, CloudflareMessage> =
	{
		id: "cloudflare",
		statusRead: CLOUDFLARE_STATUS_READ,
		init: initCloudflareCard,
		update,
		onEnter: enterCloudflare,
		onConnectStart: resetPrime,
		// The prime runs discovery and a first poll now, then re-reads the status and usage itself.
		onConnected: prime,
		onRelayedConnect: prime,
		replacesConnectedRead: true,
		// A closed popup re-reads the status and usage, then primes in case the grant landed.
		onPopupClosed: (model, env) => {
			const read = refreshCloudflare(model, env)
			const primed = prime(read.model)
			return {
				model: primed.model,
				requests: read.requests,
				commands: [...(read.commands ?? []), ...(primed.commands ?? [])],
			}
		},
		onDisconnected: (model, env) => requestUsage(model, env, "Refresh"),
		// Status and usage every 30 s while a fresh connection settles.
		subscription: {
			everyMs: 30_000,
			isActive: (model, env) => env.isShown && isSettling(model, env),
			tick: CloudflareMessage.TickedIngest(),
		},
		card: (h, model, timeZone) => [cloudflareCard(h, model, timeZone)],
		headerActions: cloudflareHeaderActions,
		flow: cloudflareFlow,
		flowView: (h, model, stage) => cloudflareFlowView(h, model, stage),
		cardStatus: (slot) =>
			fold(
				slot,
				(status): CardStatus =>
					status.connected ? { label: "Connected", variant: "ok" } : NOT_CONNECTED,
				unavailableStatus,
			),
		overview: (slot) =>
			fold(
				slot,
				(status): IntegrationOverview => {
					if (!status.connected) return CONNECT
					const zones = status.zones
					const enabledZones = Arr.filter(zones, (zone) => zone.enabled).length
					const erroringZones = Arr.filter(
						zones,
						(zone) => zone.enabled && zone.lastError != null,
					).length
					const workersFailing =
						status.workers?.enabled === true && status.workers.lastError != null
					const issue = !status.analyticsCapable
						? "Update access"
						: erroringZones > 0
							? `${countLabel(erroringZones, "zone")} erroring`
							: workersFailing
								? "Workers sync failing"
								: null
					const statParts = [
						...(zones.length > 0
							? [`${enabledZones} of ${countLabel(zones.length, "zone")} streaming`]
							: []),
						...(status.workers?.enabled === true ? ["Workers"] : []),
					]
					return {
						kind: "connected",
						...attentionOr(issue),
						context: status.accountName,
						stat: statParts.length > 0 ? Arr.join(statParts, " · ") : null,
						lastSync: lastSyncOf(
							maxMs([
								...Arr.map(zones, (zone) => zone.lastSyncedAt),
								status.workers?.lastSyncedAt,
							]),
						),
						issue,
					}
				},
				unavailableOverview,
			),
	}
