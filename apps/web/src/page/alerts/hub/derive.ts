import type { AlertDestinationDocument } from "@maple/domain/http"
import { type AlertsOverviewReady, deriveOverview } from "@maple/web-data/alerts/overview"
import {
	buildRuleStatesByRuleId,
	rowsToAlertDestinationDocuments,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { RuleBucket } from "./message"
import type { Model } from "./model"

type OverviewKey = readonly [
	Model["rules"],
	Model["states"],
	Model["incidents"],
	Model["deliveries"]["data"],
	Model["nowMs"],
]

/** Keeps the last result while every input is the same reference: views call this on every message. */
const lastBy = <K extends ReadonlyArray<unknown>, A>(compute: (key: K) => A): ((key: K) => A) => {
	const last: Array<{ key: K; value: A }> = []
	return (key) => {
		const previous = last[0]
		if (previous !== undefined && Arr.every(key, (part, index) => part === previous.key[index]))
			return previous.value
		const value = compute(key)
		last[0] = { key, value }
		return value
	}
}

const overviewFor = lastBy(
	([rules, states, incidents, deliveries, nowMs]: OverviewKey): Option.Option<AlertsOverviewReady> => {
		if (rules === null || incidents === null || nowMs === null) return Option.none()
		const stateRows = states ?? []
		const statesByRule = buildRuleStatesByRuleId(stateRows)
		return Option.some(
			deriveOverview({
				rules: Arr.map(rules, (row) => rowToAlertRuleDocument(row, statesByRule)),
				incidents: Arr.map(incidents, rowToAlertIncidentDocument),
				states: stateRows,
				deliveryEvents: Option.getOrElse(AsyncData.getData(deliveries), () => []),
				now: nowMs,
			}),
		)
	},
)

/**
 * `AlertsOverviewModel.buildOverview`: rules and incidents gate the hub; evaluation states and
 * deliveries degrade to empty while loading or failed. Recomputed only when one of them changes.
 */
export const overviewOf = (model: Model): Option.Option<AlertsOverviewReady> =>
	overviewFor([model.rules, model.states, model.incidents, model.deliveries.data, model.nowMs])

const destinationsFor = lastBy(
	([rows]: readonly [Model["destinations"]]): ReadonlyArray<AlertDestinationDocument> =>
		rowsToAlertDestinationDocuments(rows ?? []),
)

/** `useAlertDestinationsList()`, `orElse(() => [])`. */
export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	destinationsFor([model.destinations])

export type AlertsTab = "inbox" | "rules" | "uptime" | "routing"

/** Legacy `tab` values map onto the current tabs so old links keep resolving. */
export const resolveTab = (tab: string | undefined): AlertsTab => {
	switch (tab) {
		case "rules":
			return "rules"
		case "uptime":
			return "uptime"
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
