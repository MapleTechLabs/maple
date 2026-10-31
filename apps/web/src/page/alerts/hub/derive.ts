import type { AlertDestinationDocument } from "@maple/domain/http"
import { type AlertsOverviewReady, deriveOverview } from "@maple/web-data/alerts/overview"
import {
	buildRuleStatesByRuleId,
	rowToAlertDestinationDocument,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { RuleBucket } from "./message"
import type { Model } from "./model"

/**
 * `AlertsOverviewModel.buildOverview`: rules and incidents gate the hub; evaluation states and
 * deliveries degrade to empty while loading or failed.
 */
export const overviewOf = (model: Model): Option.Option<AlertsOverviewReady> => {
	if (model.rules === null || model.incidents === null || model.nowMs === null) return Option.none()
	const stateRows = model.states ?? []
	const statesByRule = buildRuleStatesByRuleId(stateRows)
	return Option.some(
		deriveOverview({
			rules: model.rules.map((row) => rowToAlertRuleDocument(row, statesByRule)),
			incidents: model.incidents.map(rowToAlertIncidentDocument),
			states: stateRows,
			deliveryEvents: Option.getOrElse(AsyncData.getData(model.deliveries.data), () => []),
			now: model.nowMs,
		}),
	)
}

/** `useAlertDestinationsList()`, `orElse(() => [])`. */
export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	(model.destinations ?? []).map(rowToAlertDestinationDocument)

export type AlertsTab = "inbox" | "rules" | "uptime" | "status-pages" | "routing"

/** Legacy `tab` values map onto the current tabs so old links keep resolving. */
export const resolveTab = (tab: string | undefined): AlertsTab => {
	switch (tab) {
		case "rules":
			return "rules"
		case "uptime":
			return "uptime"
		case "status-pages":
			return "status-pages"
		case "routing":
		case "settings":
			return "routing"
		default:
			return "inbox"
	}
}

/** `attention` is the legacy name of the blind bucket. */
export const resolveStatus = (status: string | undefined): RuleBucket | undefined => {
	switch (status) {
		case "firing":
		case "blind":
		case "healthy":
		case "disabled":
			return status
		case "attention":
			return "blind"
		default:
			return undefined
	}
}
