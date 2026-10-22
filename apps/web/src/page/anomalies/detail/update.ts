import { Option, Result } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import { ErrorIssueId } from "@maple/domain/http"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	CreateInvestigation,
	FetchIncident,
	FetchLinkedIssue,
	FetchLinkIssues,
	FetchTimeseries,
	ReadAnomalyClock,
	ResolveIncident,
	SetIncidentIssue,
} from "./command"
import { incidentOf, investigationPayload } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export const LINK_COMBOBOX_ID = "anomaly-link-issue-command"

type AnomalyRoute = Extract<AppRoute, { readonly _tag: "Anomaly" }>

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })
const failureToast = (title: string, failure: LoadFailure) => toast("error", title, failure.message)

/** One slot's request under `mode`; nothing when the slot already holds that key (`Load`). */
const slotStep = <A>(
	model: Model,
	slot: Keyed.Keyed<A, LoadFailure>,
	write: (next: Keyed.Keyed<A, LoadFailure>) => Partial<Model>,
	key: string,
	mode: Keyed.ReadMode,
	command: (key: string) => Commands[number],
): Return =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({ model: { ...model, ...write(next) }, commands: [command(next.key)] }),
	})

const chain = (first: Return, next: (model: Model) => Return): Return => {
	const second = next(first.model)
	return {
		...second,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

const loadIncident = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const key = requestKey(context.orgId, "anomalies.getIncident", { params: { id: model.incidentId } })
	return slotStep(
		model,
		model.incident,
		(incident) => ({ incident }),
		key,
		mode,
		(key) => FetchIncident({ key, id: model.incidentId }),
	)
}

/** What mounts once the incident renders: its signal series and the linked issue's card. */
const followIncident = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return =>
	Option.match(incidentOf(model), {
		onNone: () => ({ model }),
		onSome: (incident) => {
			const seriesKey = requestKey(context.orgId, "anomalies.getIncidentTimeseries", {
				params: { id: model.incidentId },
				query: {},
			})
			const series = slotStep(
				model,
				model.timeseries,
				(timeseries) => ({ timeseries }),
				seriesKey,
				mode,
				(key) => FetchTimeseries({ key, id: model.incidentId }),
			)
			const issueId = incident.errorIssueId
			if (issueId === null) return series
			const issueKey = requestKey(context.orgId, "errorIssues.retrieve", { params: { id: issueId } })
			return chain(series, (next) =>
				slotStep(
					next,
					next.linkedIssue,
					(linkedIssue) => ({ linkedIssue }),
					issueKey,
					"Load",
					(key) => FetchLinkedIssue({ key, id: issueId }),
				),
			)
		},
	})

const loadLinkIssues = (model: Model, context: PageContext): Return =>
	Option.match(incidentOf(model), {
		onNone: () => ({ model }),
		onSome: (incident) => {
			const serviceName = model.linkAllServices ? null : incident.serviceName
			const key = requestKey(context.orgId, "errorIssues.list", { serviceName })
			return slotStep(
				model,
				model.linkIssues,
				(linkIssues) => ({ linkIssues }),
				key,
				"Load",
				(key) => FetchLinkIssues({ key, serviceName }),
			)
		},
	})

export const init = (route: AnomalyRoute, context: PageContext): Return => {
	const model: Model = {
		incidentId: route.incidentId,
		nowMs: 0,
		incident: Keyed.idle(),
		timeseries: Keyed.idle(),
		linkedIssue: Keyed.idle(),
		busy: null,
		resolveDialog: Dialog.init("anomaly-resolve", "alert-dialog"),
		linkDialog: Dialog.init("anomaly-link-issue", "command-dialog"),
		linkCombobox: Combobox.init(LINK_COMBOBOX_ID, "autocomplete", { isOpen: true }),
		linkAllServices: false,
		linkIssues: Keyed.idle(),
		chart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	const loaded = loadIncident(model, context, "Load")
	return {
		model: loaded.model,
		commands: [
			ReadAnomalyClock(),
			...(loaded.commands ?? []),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const dialogStep = (
	model: Model,
	field: "resolveDialog" | "linkDialog",
	step: ReturnType<typeof Dialog.update>,
	wrap: (message: Dialog.Message) => Message,
): Return => ({
	model: { ...model, [field]: step.model },
	commands: Command.mapMessages(step.commands ?? [], wrap),
})

const wrapResolve = (message: Dialog.Message) => Message.GotResolveDialogMessage({ message })
const wrapLink = (message: Dialog.Message) => Message.GotLinkDialogMessage({ message })

/**
 * A successful write re-reads the incident (its `reactivityKeys`); the answer re-follows the issue.
 * It supersedes a live-refresh read in flight, so a pre-write answer cannot land last.
 */
const afterWrite = (model: Model, context: PageContext): Return =>
	loadIncident({ ...model, busy: null }, context, "Supersede")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchIncident: ({ key, result }) =>
			followIncident(
				{ ...model, incident: Keyed.accept(model.incident, key, result) },
				context,
				"Load",
			),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedFetchLinkedIssue: ({ key, result }) => ({
			model: { ...model, linkedIssue: Keyed.accept(model.linkedIssue, key, result) },
		}),
		CompletedFetchLinkIssues: ({ key, result }) => ({
			model: { ...model, linkIssues: Keyed.accept(model.linkIssues, key, result) },
		}),
		TickedLiveRefresh: ({ nowMs }) =>
			chain(loadIncident({ ...model, nowMs }, context, "Refresh"), (next) =>
				followIncident(next, context, "Refresh"),
			),
		ClickedRetry: () => loadIncident(model, context, "Refresh"),
		ClickedInvestigate: () =>
			model.busy !== null
				? { model }
				: Option.match(incidentOf(model), {
						onNone: () => ({ model }),
						onSome: (incident) => ({
							model: { ...model, busy: "investigate" },
							commands: [CreateInvestigation({ payload: investigationPayload(incident) })],
						}),
					}),
		CompletedInvestigate: ({ result }) =>
			Result.match(result, {
				onSuccess: (id) => ({
					model: { ...model, busy: null },
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.Investigation({ id, search: {} })),
						isReplace: false,
					}),
				}),
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: failureToast("Failed to open investigation", failure),
				}),
			}),
		ClickedResolve: () =>
			dialogStep(model, "resolveDialog", Dialog.open(model.resolveDialog), wrapResolve),
		ClickedConfirmResolve: () =>
			model.busy !== null
				? { model }
				: {
						model: { ...model, busy: "resolve" },
						commands: [ResolveIncident({ id: model.incidentId })],
					},
		CompletedResolve: ({ result }) =>
			Result.match(result, {
				onSuccess: () => {
					const refreshed = afterWrite(model, context)
					const closed = dialogStep(
						refreshed.model,
						"resolveDialog",
						Dialog.close(refreshed.model.resolveDialog),
						wrapResolve,
					)
					return {
						model: closed.model,
						commands: [...(refreshed.commands ?? []), ...(closed.commands ?? [])],
						outMessage: toast("success", "Anomaly resolved"),
					}
				},
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: failureToast("Resolve failed", failure),
				}),
			}),
		ClickedLinkIssue: () =>
			chain(dialogStep(model, "linkDialog", Dialog.open(model.linkDialog), wrapLink), (next) =>
				loadLinkIssues(
					{
						...next,
						linkCombobox: Combobox.init(LINK_COMBOBOX_ID, "autocomplete", { isOpen: true }),
					},
					context,
				),
			),
		ClickedUnlink: () =>
			model.busy !== null
				? { model }
				: {
						model: { ...model, busy: "unlink" },
						commands: [SetIncidentIssue({ id: model.incidentId, issueId: null })],
					},
		SelectedLinkIssue: ({ issueId }) =>
			model.busy !== null
				? { model }
				: {
						model: { ...model, busy: "link" },
						commands: [SetIncidentIssue({ id: model.incidentId, issueId })],
					},
		CompletedSetIssue: ({ issueId, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const refreshed = afterWrite(model, context)
					const message = toast("success", issueId === null ? "Issue unlinked" : "Linked to issue")
					if (issueId === null) return { ...refreshed, outMessage: message }
					const closed = dialogStep(
						refreshed.model,
						"linkDialog",
						Dialog.close(refreshed.model.linkDialog),
						wrapLink,
					)
					return {
						model: closed.model,
						commands: [...(refreshed.commands ?? []), ...(closed.commands ?? [])],
						outMessage: message,
					}
				},
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: failureToast(issueId === null ? "Unlink failed" : "Link failed", failure),
				}),
			}),
		GotLinkComboboxMessage: ({ message: inner }) => {
			// `onClick={() => onSelect(issue.id)}`: a picked item links; the rest is the input's own state.
			if (inner._tag === "ClickedItem")
				return update(
					model,
					Message.SelectedLinkIssue({ issueId: ErrorIssueId.make(inner.value) }),
					context,
				)
			const next = Combobox.update(model.linkCombobox, inner)
			// Enter on the active item picks like a click; the input keeps the query, not the id.
			if (next.outMessage?._tag === "ChangedValue")
				return update(
					model,
					Message.SelectedLinkIssue({ issueId: ErrorIssueId.make(next.outMessage.value) }),
					context,
				)
			return {
				model: { ...model, linkCombobox: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotLinkComboboxMessage({ message }),
				),
			}
		},
		ToggledLinkScope: () =>
			loadLinkIssues({ ...model, linkAllServices: !model.linkAllServices }, context),
		GotResolveDialogMessage: ({ message: inner }) =>
			model.busy !== null &&
			inner._tag !== "GotAnimationMessage" &&
			inner._tag !== "CompletedMountDialog"
				? { model }
				: dialogStep(model, "resolveDialog", Dialog.update(model.resolveDialog, inner), wrapResolve),
		GotLinkDialogMessage: ({ message: inner }) =>
			dialogStep(model, "linkDialog", Dialog.update(model.linkDialog, inner), wrapLink),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotChartMessage({ message }),
				),
			}
		},
	})
