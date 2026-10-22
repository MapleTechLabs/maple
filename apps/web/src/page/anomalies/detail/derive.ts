import type { AnomalyIncidentDocument } from "@maple/domain/http"
import type { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { anomalyIncidentFromV2 } from "../../../lib/services/anomalies"
import { SIGNAL_LABEL } from "@maple/web-data/anomalies/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import type { Model } from "./model"

const NOT_FOUND_TAG = "@maple/http/anomalies/AnomalyIncidentNotFoundError"

/** `isIncidentNotFound`: a typed 404 renders the not-found body, not the error. */
export const isNotFound = (failure: LoadFailure): boolean => failure._tag === NOT_FOUND_TAG

export const incidentOf = (model: Model): Option.Option<AnomalyIncidentDocument> =>
	Option.map(AsyncData.getData(model.incident.data), anomalyIncidentFromV2)

/** The page state `ResultPage` switches on. */
export type PageState =
	| { readonly _tag: "Loading" }
	| { readonly _tag: "NotFound" }
	| { readonly _tag: "Failed"; readonly failure: LoadFailure }
	| { readonly _tag: "Loaded"; readonly incident: AnomalyIncidentDocument }

export const pageStateOf = (model: Model): PageState =>
	AsyncData.match(model.incident.data, {
		onIdle: (): PageState => ({ _tag: "Loading" }),
		onLoading: (): PageState => ({ _tag: "Loading" }),
		onFailure: (failure): PageState =>
			isNotFound(failure) ? { _tag: "NotFound" } : { _tag: "Failed", failure },
		onStale: ({ error }): PageState =>
			isNotFound(error) ? { _tag: "NotFound" } : { _tag: "Failed", failure: error },
		onSuccess: (incident): PageState => ({ _tag: "Loaded", incident: anomalyIncidentFromV2(incident) }),
		onRefreshing: (incident): PageState => ({
			_tag: "Loaded",
			incident: anomalyIncidentFromV2(incident),
		}),
	})

export const crumbOf = (incident: AnomalyIncidentDocument): string =>
	[incident.serviceName, SIGNAL_LABEL[incident.signalType], incident.deploymentEnv]
		.filter(Boolean)
		.join(" · ")

/** The `investigations.create` payload `investigate` sends. */
export const investigationPayload = (incident: AnomalyIncidentDocument): V2InvestigationCreateParams => ({
	subject:
		incident.errorIssueId !== null
			? {
					type: "incident",
					incident_kind: "anomaly",
					incident_id: incident.id,
					issue_id: incident.errorIssueId,
				}
			: { type: "incident", incident_kind: "anomaly", incident_id: incident.id },
	snapshot: {
		title: `${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`,
		scope: incident.deploymentEnv || incident.serviceName,
		status: incident.status,
		severity: incident.severity === "critical" ? "critical" : "medium",
		facts: [
			{ label: "Signal", value: incident.signalType },
			{ label: "Service", value: incident.serviceName },
			{ label: "Last observed", value: String(incident.lastObservedValue) },
		],
		references: incident.errorIssueId
			? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }]
			: [],
		incidentStartedAt: incident.firstTriggeredAt,
		incidentEndedAt: incident.resolvedAt,
	},
})
