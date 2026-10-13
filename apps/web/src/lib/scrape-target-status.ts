import type { Tone } from "@maple/ui/lib/tone"
import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

export interface ScheduledScrapeStatus {
	readonly label: string
	readonly detail: string
	/** `neutral` renders as an outline badge. */
	readonly tone: Tone
}

type TargetStatusFields = Pick<V2ScrapeTarget, "enabled" | "last_scrape_at" | "last_scrape_error">

const disabledStatus = (): ScheduledScrapeStatus => ({
	label: "Disabled",
	detail: "Collector skips this target",
	tone: "neutral",
})

/** List-row status from the rollup fields already returned by the targets API. */
export function scheduledStatusFromRollup(target: TargetStatusFields): ScheduledScrapeStatus {
	if (!target.enabled) return disabledStatus()
	if (target.last_scrape_error !== null) {
		return {
			label: "Down",
			detail:
				target.last_scrape_at === null
					? "No successful scheduled scrape"
					: `Last success ${formatRelativeTime(target.last_scrape_at)}`,
			tone: "crit",
		}
	}
	if (target.last_scrape_at === null) {
		return {
			label: "No checks",
			detail: "No scheduled scrape observed",
			tone: "warn",
		}
	}
	return {
		label: "Up",
		detail: `Scheduled ${formatRelativeTime(target.last_scrape_at)}`,
		tone: "ok",
	}
}

/** Detail-panel status from the selected target's latest persisted check. */
export function scheduledStatusFromChecks(
	target: Pick<V2ScrapeTarget, "enabled">,
	latestCheck: V2ScrapeTargetCheck | null,
	isLoading: boolean,
	checksUnavailable: boolean,
): ScheduledScrapeStatus {
	if (!target.enabled) return disabledStatus()
	if (isLoading) {
		return {
			label: "Checking",
			detail: "Loading scheduled history",
			tone: "neutral",
		}
	}
	if (checksUnavailable) {
		return {
			label: "Unavailable",
			detail: "Failed to load scheduled checks",
			tone: "neutral",
		}
	}
	if (latestCheck === null) {
		return {
			label: "No checks",
			detail: "No scheduled scrape observed",
			tone: "warn",
		}
	}
	if (latestCheck.success) {
		return {
			label: "Up",
			detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
			tone: "ok",
		}
	}
	return {
		label: "Down",
		detail: `Scheduled ${formatRelativeTime(latestCheck.timestamp)}`,
		tone: "crit",
	}
}
