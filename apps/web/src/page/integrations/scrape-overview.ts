import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import type { Statuses } from "./model"
import {
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	isoMs,
	lastSyncOf,
	maxMs,
	NOT_CONNECTED,
	SET_UP,
	unavailableOverview,
	unavailableStatus,
} from "./overview"

// The header badge and catalog row of sources read through scrape targets (Prometheus, and
// PlanetScale before it is connected).

export const scrapeStatus = (statuses: Statuses, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): CardStatus => {
			const targets = Arr.filter(data, (target) => target.target_type === targetType)
			if (targets.length === 0) return NOT_CONNECTED
			const failing = Arr.some(targets, (target) => target.enabled && target.last_scrape_error !== null)
			const enabled = Arr.filter(targets, (target) => target.enabled).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				label: `${countLabel(targets.length, noun)} · ${enabled} enabled`,
				variant: failing ? "warn" : "ok",
			}
		},
		unavailableStatus,
	)

export const scrapeOverview = (statuses: Statuses, targetType: "prometheus" | "planetscale") =>
	fold(
		statuses.scrapeTargets,
		(data): IntegrationOverview => {
			const targets = Arr.filter(data, (target) => target.target_type === targetType)
			if (targets.length === 0) return targetType === "prometheus" ? SET_UP : CONNECT
			const enabled = Arr.filter(targets, (target) => target.enabled).length
			const failing = Arr.filter(
				targets,
				(target) => target.enabled && target.last_scrape_error !== null,
			).length
			const noun = targetType === "planetscale" ? "org" : "target"
			return {
				kind: "connected",
				health: failing > 0 ? "attention" : "healthy",
				stateLabel: failing > 0 ? "Needs attention" : "Healthy",
				context: countLabel(targets.length, `scrape ${noun}`),
				stat: `${enabled} of ${targets.length} enabled`,
				lastSync: lastSyncOf(maxMs(Arr.map(targets, (t) => isoMs(t.last_scrape_at))), "scraped"),
				issue: failing > 0 ? `${countLabel(failing, noun)} failing` : null,
			}
		},
		unavailableOverview,
	)
