import type { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { formatSignalValue, signalLabels } from "@maple/web-data/alerts/form-utils"
import { incidentGroup } from "@maple/web-data/alerts/incident-timeline"
import {
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Option, Result, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	CreateInvestigation,
	FetchIncidentChecks,
	FetchIncidentDeliveries,
	FetchIncidentInvestigation,
	FetchIncidentPreview,
	FetchIncidentSession,
	FetchIncidentSilences,
	ReadIncidentClock,
} from "./command"
import { incidentViewOf, minuteOf, ruleStatesOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import * as SilenceDialog from "../silence-dialog/dialog"
import { matchersForRule } from "../shared/silences"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type IncidentRoute = Extract<AppRoute, { readonly _tag: "AlertIncident" }>

const silencesKey = (context: PageContext) =>
	requestKey(context.orgId, "alertSilences.list", { query: { status: "active", limit: 100 } })

const requestSilences = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.silences, silencesKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (silences) => ({
			model: { ...model, silences },
			commands: [FetchIncidentSilences({ key: silences.key })],
		}),
	})

/** The silence dialog's outcome: a toast, and a re-read so the header shows the new silence. */
const liftSilenceDialog = (
	model: Model,
	context: PageContext,
	step: ReturnType<typeof SilenceDialog.update>,
): Return => {
	const next = { ...model, silenceDialog: step.model }
	const commands = Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotSilenceDialogMessage({ message }),
	)
	if (step.outMessage === undefined) return { model: next, commands }
	return SilenceDialog.OutMessage.match(step.outMessage, {
		RequestedToast: ({ type, title, description }) => ({
			model: next,
			commands,
			outMessage: PageOutMessage.RequestedToast({ type, title, description }),
		}),
		CreatedSilence: () => {
			const refreshed = requestSilences(next, context, "Supersede")
			return {
				model: refreshed.model,
				commands: [...commands, ...(refreshed.commands ?? []), ReadIncidentClock()],
				outMessage: PageOutMessage.RequestedToast({
					type: "success",
					title: "Alerts silenced",
					description: "",
				}),
			}
		},
	})
}

/** Silence this incident's rule, or only its group when the rule is grouped by service. */
const openSilence = (model: Model, context: PageContext): Return =>
	// The rule decides whether one group or the whole rule is silenced, so wait for it.
	model.rules === null
		? { model }
		: Option.match(incidentViewOf(model), {
				onNone: () => ({ model }),
				onSome: ({ incident, rule }) => {
					const group = incidentGroup(incident)
					const name = rule?.name ?? incident.ruleName
					const target =
						rule === null
							? { label: name, matchers: { rule_ids: [incident.ruleId] } }
							: {
									label: group === null ? name : `${name} · ${group}`,
									matchers: matchersForRule(rule, group),
								}
					return liftSilenceDialog(
						model,
						context,
						SilenceDialog.openFor(
							model.silenceDialog,
							target,
							context.timeZone,
							model.nowMs ?? 0,
						),
					)
				},
			})

export const init = (route: IncidentRoute, context: PageContext): Return => {
	const initial: Return = {
		model: {
			incidentId: route.incidentId,
			nowMs: null,
			incidents: null,
			rules: null,
			states: null,
			preview: Keyed.idle(),
			checks: Keyed.idle(),
			deliveries: Keyed.idle(),
			investigation: Keyed.idle(),
			isStartingInvestigation: false,
			chart: Chart.init(),
			chartRuntime: { _tag: "Loading" },
			themeColors: null,
			silences: Keyed.idle(),
			silenceDialog: SilenceDialog.init("alert-incident-silence"),
			grants: [],
		},
		commands: [
			ReadIncidentClock(),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
	const silences = requestSilences(initial.model, context, "Load")
	return {
		model: silences.model,
		commands: [...(initial.commands ?? []), ...(silences.commands ?? []), FetchIncidentSession()],
	}
}

/** An atom never refetches a failed read on its own: a same-key `Load` leaves the slot alone. */
const sameKey = <A, E>(slot: Keyed.Keyed<A, E>, key: string) => slot.key === key

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
					Option.map(
						sameKey(model.deliveries, deliveriesKey)
							? Option.none()
							: Keyed.request(model.deliveries, deliveriesKey, "Load"),
						(deliveries) => ({
							patch: { deliveries },
							commands: [FetchIncidentDeliveries({ key: deliveriesKey, incidentId })],
						}),
					),
				),
				...Option.toArray(
					Option.map(
						sameKey(model.investigation, investigationKey)
							? Option.none()
							: Keyed.request(model.investigation, investigationKey, "Load"),
						(investigation) => ({
							patch: { investigation },
							commands: [FetchIncidentInvestigation({ key: investigationKey, incidentId })],
						}),
					),
				),
				...Option.toArray(
					Option.flatMap(view.checksQuery, (query) => {
						const key = requestKey(context.orgId, "alertRules.checksSummary", query)
						return Option.map(
							sameKey(model.checks, key)
								? Option.none()
								: Keyed.request(model.checks, key, "Load"),
							(checks) => ({
								patch: { checks },
								commands: [FetchIncidentChecks({ key, ...query })],
							}),
						)
					}),
				),
				...Option.toArray(
					Option.flatMap(view.payload, (payload) => {
						const key = requestKey(context.orgId, "alertRules.preview", payload)
						return Option.map(
							sameKey(model.preview, key)
								? Option.none()
								: Keyed.request(model.preview, key, "Load"),
							(preview) => ({
								patch: { preview },
								commands: [FetchIncidentPreview({ key, payload })],
							}),
						)
					}),
				),
			]
			return {
				model: Arr.reduce(steps, model, (next, step) => ({ ...next, ...step.patch })),
				commands: Arr.flatMap(steps, (step) => step.commands),
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
				{
					label: "Observed",
					value: formatSignalValue(incident.signalType, incident.lastObservedValue),
				},
				{ label: "Threshold", value: formatSignalValue(incident.signalType, incident.threshold) },
			],
			references: incident.errorIssueId
				? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }]
				: [],
			incidentStartedAt: incident.firstTriggeredAt,
			incidentEndedAt: incident.resolvedAt,
		},
	}))

const withRows = (model: Model, context: PageContext, orgId: string, patch: Partial<Model>): Return =>
	orgId === context.orgId ? followData({ ...model, ...patch }, context) : { model }

const isSameIncidentRow = Schema.toEquivalence(AlertIncidentRowSchema)
const isSameRuleRows = Schema.toEquivalence(Schema.Array(AlertRuleRowSchema))
const isSameStateRows = Schema.toEquivalence(Schema.Array(AlertRuleStateRowSchema))

const incidentRuleIdOf = (model: Model) =>
	Option.map(
		Arr.findFirst(model.incidents ?? [], (row) => row.id === model.incidentId),
		(row) => row.rule_id,
	)

/**
 * The live rules and states are the whole org's and change on every alert tick. Once the incident
 * is known, a change that leaves its own rule as it was keeps the model, so the page does not redraw.
 */
const withRuleRows = (
	model: Model,
	context: PageContext,
	orgId: string,
	patch: Readonly<{ rules: NonNullable<Model["rules"]> } | { states: NonNullable<Model["states"]> }>,
): Return => {
	const foundRuleId = incidentRuleIdOf(model)
	if (orgId !== context.orgId || Option.isNone(foundRuleId)) return withRows(model, context, orgId, patch)
	const ruleId = foundRuleId.value
	const isUnchanged =
		"rules" in patch
			? model.rules !== null &&
				isSameRuleRows(
					Arr.filter(model.rules, (row) => row.id === ruleId),
					Arr.filter(patch.rules, (row) => row.id === ruleId),
				)
			: model.states !== null &&
				isSameStateRows(
					ruleStatesOf(model, ruleId),
					ruleStatesOf({ ...model, states: patch.states }, ruleId),
				)
	return isUnchanged ? { model } : withRows(model, context, orgId, patch)
}
const incidentRowOf = (model: Model, rows: Model["incidents"]) =>
	Arr.findFirst(rows ?? [], (row) => row.id === model.incidentId)

/** `clockAtSync`: once the incident row itself changes, the minute clock is read again. */
const withIncidents = (
	model: Model,
	context: PageContext,
	orgId: string,
	rows: Model["incidents"],
): Return => {
	const next = withRows(model, context, orgId, { incidents: rows })
	const before = incidentRowOf(model, model.incidents)
	const after = incidentRowOf(model, rows)
	const isChanged =
		orgId === context.orgId &&
		Option.isSome(before) &&
		Option.isSome(after) &&
		!isSameIncidentRow(before.value, after.value)
	return isChanged ? { ...next, commands: [...(next.commands ?? []), ReadIncidentClock()] } : next
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => followData({ ...model, nowMs: minuteOf(nowMs) }, context),
		UpdatedIncidents: ({ orgId, rows }) => withIncidents(model, context, orgId, rows),
		UpdatedRules: ({ orgId, rows }) => withRuleRows(model, context, orgId, { rules: rows }),
		UpdatedRuleStates: ({ orgId, rows }) => withRuleRows(model, context, orgId, { states: rows }),
		CompletedFetchPreview: ({ key, result }) => ({
			model: { ...model, preview: Keyed.accept(model.preview, key, result) },
		}),
		CompletedFetchChecks: ({ key, result }) => ({
			model: { ...model, checks: Keyed.accept(model.checks, key, result) },
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
						title: "Couldn't start investigation",
						description: failure.message,
					}),
				}),
			}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedFetchSilences: ({ key, result }) => ({
			model: { ...model, silences: Keyed.accept(model.silences, key, result) },
		}),
		ClickedSilence: () => openSilence(model, context),
		CompletedFetchSession: ({ grants }) => ({ model: { ...model, grants } }),
		GotSilenceDialogMessage: ({ message: child }) =>
			liftSilenceDialog(model, context, SilenceDialog.update(model.silenceDialog, child)),
		GotChartMessage: ({ message: child }) => {
			const next = Chart.update(model.chart, child)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotChartMessage({ message }),
				),
			}
		},
	})
