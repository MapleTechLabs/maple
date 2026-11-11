import {
	dayState,
	STATUS_PAGE_HISTORY_DAYS,
	type StatusPageDayBar,
	type StatusPageDayState,
	type StatusPageSnapshot,
	uptimePercent,
} from "@maple/domain/status-page"
import { Array as Arr } from "effect"
import { barComponents } from "./history"

/** Most days `/api/v1/uptime.json` returns: all the snapshot carries. */
export const UPTIME_MAX_DAYS = STATUS_PAGE_HISTORY_DAYS

const DAY_STATUS = {
	none: "no_data",
	ok: "operational",
	degraded: "degraded",
	down: "down",
} as const satisfies Record<StatusPageDayState, string>

/** Floored to 4 decimals, like the page floors to 2: a day with downtime never reads as 100. */
const percentOf = (days: ReadonlyArray<StatusPageDayBar>): number | null => {
	const percent = uptimePercent(days)
	return percent === null ? null : Math.floor(Number((percent * 10_000).toFixed(6))) / 10_000
}

/**
 * Daily uptime of the components whose bars the page shows (a component without a monitor, or
 * with uptime hidden, has none), over the last `days` UTC days. Null when `componentId` names
 * no such component.
 */
export const renderUptimeJson = (
	snapshot: StatusPageSnapshot,
	pageUrl: string,
	input: { readonly days: number; readonly componentId: string | null },
) => {
	const components = Arr.filter(
		barComponents(snapshot.components),
		(component) => input.componentId === null || component.id === input.componentId,
	)
	if (input.componentId !== null && components.length === 0) return null
	return {
		page: {
			id: snapshot.pageId,
			name: snapshot.page.name,
			url: snapshot.page.websiteUrl,
			status_url: pageUrl,
			time_zone: "Etc/UTC",
		},
		days: input.days,
		components: Arr.map(components, (component) => {
			const days = component.days.slice(-input.days)
			return {
				id: component.id,
				name: component.name,
				group: component.group,
				uptime_percent: percentOf(days),
				days: Arr.map(days, (bar) => ({
					date: bar.day,
					uptime_percent: percentOf([bar]),
					status: DAY_STATUS[dayState(bar)],
				})),
			}
		}),
		generated_at: new Date(snapshot.generatedAt).toISOString(),
	}
}
