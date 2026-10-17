import type { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { formatSignalValue, signalLabels } from "@maple/web-data/alerts/form-utils"
import { incidentGroup } from "@maple/web-data/alerts/incident-timeline"
import { Option, Result } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	CreateInvestigation,
	FetchIncidentDeliveries,
	FetchIncidentInvestigation,
	FetchIncidentPreview,
	ReadIncidentClock,
} from "./command"
import { incidentViewOf, minuteOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type IncidentRoute = Extract<AppRoute, { readonly _tag: "AlertIncident" }>

export const init = (route: IncidentRoute, _context: PageContext): Return => ({
	model: {
		incidentId: route.incidentId,
		search: route.search,
		nowMs: null,
		incidents: null,
		rules: null,
		states: null,
		preview: Keyed.idle(),
		deliveries: Keyed.idle(),
		investigation: Keyed.idle(),
		isStartingInvestigation: false,
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	},
	commands: [
		ReadIncidentClock(),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/**
 * The reads `IncidentDetail` sends once it mounts: deliveries and the investigation for the
 * incident, and the preview once the rule is known. Idempotent (`Load` keeps a same-key slot).
 */
const followData = (model: Model, context: PageContext): Return =>
	Option.match(incidentViewOf(model), {
		onNone: () => ({ model }),
		onSome: (view) => {
			const incidentId = view.incident.id
			const deliveriesKey = requestKey(context.orgId, "alertDeliveries.list", {
				query: { incident_id: incidentId, limit: 100 },
			})
			const investigationKey = requestKey(context.orgId, "investigations.list", {
				query: { incident_kind: "alert", incident_id: incidentId, limit: 1 },
			})
			const steps: ReadonlyArray<{ patch: Partial<Model>; commands: Commands }> = [
				...Option.toArray(
					Option.map(Keyed.request(model.deliveries, deliveriesKey, "Load"), (deliveries) => ({
						patch: { deliveries },
						commands: [FetchIncidentDeliveries({ key: deliveriesKey, incidentId })],
					})),
				),
				...Option.toArray(
					Option.map(Keyed.request(model.investigation, investigationKey, "Load"), (investigation) => ({
						patch: { investigation },
						commands: [FetchIncidentInvestigation({ key: investigationKey, incidentId })],
					})),
				),
				...Option.toArray(
					Option.flatMap(view.payload, (payload) => {
						const key = requestKey(context.orgId, "alertRules.preview", payload)
						return Option.map(Keyed.request(model.preview, key, "Load"), (preview) => ({
							patch: { preview },
							commands: [FetchIncidentPreview({ key, payload })],
						}))
					}),
				),
			]
			return {
				model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
				commands: steps.flatMap((step) => step.commands),
			}
		},
	})

const createPayload = (model: Model): Option.Option<V2InvestigationCreateParams> =>
	Option.map(incidentViewOf(model), ({ incident }) => ({
		subject:
			incident.errorIssueId != null
				? {
						type: "incident" as const,
						incident_kind: "alert" as const,
						incident_id: incident.id,
						issue_id: incident.errorIssueId,
					}
				: { type: "incident" as const, incident_kind: "alert" as const, incident_id: incident.id },
		snapshot: {
			title: incident.ruleName,
			scope: incidentGroup(incident) ?? "all",
			status: incident.status,
			severity: incident.severity === "critical" ? ("critical" as const) : ("medium" as const),
			facts: [
				{ label: "Signal", value: signalLabels[incident.signalType] },
				{ label: "Observed", value: formatSignalValue(incident.signalType, incident.lastObservedValue) },
				{ label: "Threshold", value: formatSignalValue(incident.signalType, incident.threshold) },
			],
			references: incident.errorIssueId ? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }] : [],
			incidentStartedAt: incident.firstTriggeredAt,
			incidentEndedAt: incident.resolvedAt,
		},
	}))

const withRows = (model: Model, context: PageContext, orgId: string, patch: Partial<Model>): Return =>
	orgId === context.orgId ? followData({ ...model, ...patch }, context) : { model }

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => followData({ ...model, nowMs: minuteOf(nowMs) }, context),
		UpdatedIncidents: ({ orgId, rows }) => withRows(model, context, orgId, { incidents: rows }),
		UpdatedRules: ({ orgId, rows }) => withRows(model, context, orgId, { rules: rows }),
		UpdatedRuleStates: ({ orgId, rows }) => withRows(model, context, orgId, { states: rows }),
		CompletedFetchPreview: ({ key, result }) => ({
			model: { ...model, preview: Keyed.accept(model.preview, key, result) },
		}),
		CompletedFetchDeliveries: ({ key, result }) => ({
			model: { ...model, deliveries: Keyed.accept(model.deliveries, key, result) },
		}),
		CompletedFetchInvestigation: ({ key, result }) => ({
			model: { ...model, investigation: Keyed.accept(model.investigation, key, result) },
		}),
		ClickedInvestigate: () =>
			model.isStartingInvestigation
				? { model }
				: Option.match(createPayload(model), {
						onNone: () => ({ model }),
						onSome: (payload) => ({
							model: { ...model, isStartingInvestigation: true },
							commands: [CreateInvestigation({ payload })],
						}),
					}),
		CompletedCreateInvestigation: ({ result }) =>
			Result.match(result, {
				onSuccess: (id) => ({
					model: { ...model, isStartingInvestigation: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.Investigation({ id, search: {} })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, isStartingInvestigation: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: "Failed to start investigation",
						description: failure.message,
					}),
				}),
			}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: child }) => {
			const next = Chart.update(model.chart, child)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotChartMessage({ message })),
			}
		},
	})
