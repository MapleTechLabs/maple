import type { AlertDestinationDocument, AlertIncidentDocument } from "@maple/domain/http"
import { type AlertsOverviewReady, deriveOverview } from "@maple/web-data/alerts/overview"
import {
	buildRuleStatesByRuleId,
	rowsToAlertDestinationDocuments,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { lastBy } from "../../kit/last-by"
import type { InboxSignal, IncidentStatusFilter, RuleBucket } from "./message"
import type { Model } from "./model"

type OverviewKey = readonly [
	Model["rules"],
	Model["states"],
	Model["incidents"],
	Model["deliveries"]["data"],
	Model["nowMs"],
]

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

/** An incident is about a service: its labels say so, else its stored "service (env)" label. */
const isAboutService = (incident: AlertIncidentDocument, serviceName: string): boolean =>
	incident.labels?.service !== undefined
		? incident.labels.service === serviceName
		: incident.groupLabel === serviceName ||
			(incident.groupLabel != null && Str.startsWith(`${serviceName} (`)(incident.groupLabel))

type SignalKey = readonly [...OverviewKey, string | undefined]

const anomalyOverviewFor = lastBy(
	([
		rules,
		states,
		incidents,
		deliveries,
		nowMs,
		serviceName,
	]: SignalKey): Option.Option<AlertsOverviewReady> => {
		if (rules === null || incidents === null || nowMs === null) return Option.none()
		const stateRows = states ?? []
		const statesByRule = buildRuleStatesByRuleId(stateRows)
		const anomalyIncidents = Arr.filter(
			Arr.map(
				Arr.filter(incidents, (row) => row.signal_type === "anomaly"),
				rowToAlertIncidentDocument,
			),
			(incident) => serviceName === undefined || isAboutService(incident, serviceName),
		)
		return Option.some(
			deriveOverview({
				rules: Arr.map(
					Arr.filter(rules, (row) => row.signal_type === "anomaly"),
					(row) => rowToAlertRuleDocument(row, statesByRule),
				),
				incidents: anomalyIncidents,
				states: stateRows,
				deliveryEvents: Option.getOrElse(AsyncData.getData(deliveries), () => []),
				now: nowMs,
			}),
		)
	},
)

/** The overview narrowed to anomaly rules and incidents, and to one service when the view names one. */
export const anomalyOverviewOf = (model: Model): Option.Option<AlertsOverviewReady> =>
	anomalyOverviewFor([
		model.rules,
		model.states,
		model.incidents,
		model.deliveries.data,
		model.nowMs,
		model.search.serviceName,
	])

/** The Inbox's signal view; old anomaly links say "anomalies". */
export const resolveSignal = (signal: string | undefined): InboxSignal =>
	signal === "anomaly" || signal === "anomalies" ? "anomaly" : null

/** A signal view lists open incidents unless the link asks for resolved or all of them. */
export const resolveIncidentStatus = (status: string | undefined): IncidentStatusFilter =>
	status === "resolved" || status === "all" ? status : "open"

const destinationsFor = lastBy(
	([rows]: readonly [Model["destinations"]]): ReadonlyArray<AlertDestinationDocument> =>
		rowsToAlertDestinationDocuments(rows ?? []),
)

/** `useAlertDestinationsList()`, `orElse(() => [])`. */
export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	destinationsFor([model.destinations])

export type AlertsTab = "inbox" | "rules" | "uptime" | "slos" | "routing"

/** Legacy `tab` values map onto the current tabs so old links keep resolving. */
export const resolveTab = (tab: string | undefined): AlertsTab => {
	switch (tab) {
		case "rules":
			return "rules"
		case "uptime":
			return "uptime"
		case "slos":
			return "slos"
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
