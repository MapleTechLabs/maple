import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { sloIdFromUrl, slosTabHref } from "../shared/slo-commands"
import {
	DeleteSlo,
	FetchSlo,
	FetchSloHistory,
	FetchSloSession,
	FetchSloStatus,
	ReadSloClock,
	ToggleSloAlerting,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type SloRoute = Extract<AppRoute, { readonly _tag: "AlertsSlo" }>

export const DELETE_DIALOG_ID = "slo-delete"

type Slot = "slo" | "status" | "history"

const keyOf = (context: PageContext, slot: Slot, sloId: string) =>
	requestKey(context.orgId, `slos.${slot === "slo" ? "retrieve" : slot}`, { sloId })

/** Reads one of the page's three slots under `mode`; nothing for an id that does not decode. */
const request = (model: Model, context: PageContext, slot: Slot, mode: Keyed.ReadMode): Return => {
	const sloId = model.sloId
	if (sloId === null) return { model }
	const key = keyOf(context, slot, sloId)
	switch (slot) {
		case "slo":
			return Option.match(Keyed.requestFor(model.slo, key, mode), {
				onNone: () => ({ model }),
				onSome: (slo) => ({ model: { ...model, slo }, commands: [FetchSlo({ key, sloId })] }),
			})
		case "status":
			return Option.match(Keyed.requestFor(model.status, key, mode), {
				onNone: () => ({ model }),
				onSome: (status) => ({
					model: { ...model, status },
					commands: [FetchSloStatus({ key, sloId })],
				}),
			})
		case "history":
			return Option.match(Keyed.requestFor(model.history, key, mode), {
				onNone: () => ({ model }),
				onSome: (history) => ({
					model: { ...model, history },
					commands: [FetchSloHistory({ key, sloId })],
				}),
			})
	}
}

/** The SLO, its status and its history are read side by side: each only needs the id. */
const requestAll = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const slo = request(model, context, "slo", mode)
	const status = request(slo.model, context, "status", mode)
	const history = request(status.model, context, "history", mode)
	return {
		model: history.model,
		commands: [...(slo.commands ?? []), ...(status.commands ?? []), ...(history.commands ?? [])],
	}
}

export const init = (route: SloRoute, context: PageContext): Return => {
	const model: Model = {
		rawSloId: route.sloId,
		sloId: Option.getOrNull(sloIdFromUrl(route.sloId)),
		nowMs: null,
		slo: Keyed.idle(),
		status: Keyed.idle(),
		history: Keyed.idle(),
		destinations: null,
		incidents: null,
		grants: [],
		isTogglingAlerting: false,
		isDeleting: false,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
		budgetChart: Chart.init(),
		sliChart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	const reads = requestAll(model, context, "Load")
	return {
		model: reads.model,
		commands: [
			ReadSloClock(),
			FoldkitCommand.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
			FetchSloSession({ orgId: context.orgId }),
			...(reads.commands ?? []),
		],
	}
}

export const sloOf = (model: Model) => AsyncData.getData(model.slo.data)

const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

const toggleAlerting = (model: Model): Return =>
	Option.match(sloOf(model), {
		onNone: () => ({ model }),
		onSome: (slo) =>
			model.isTogglingAlerting
				? { model }
				: {
						model: { ...model, isTogglingAlerting: true },
						commands: [ToggleSloAlerting({ sloId: slo.id, enabled: !slo.alerting.enabled })],
					},
	})

/** Runs the delete dialog; `Closed` (Escape, Cancel) is ignored while the delete runs. */
const updateDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const confirmDelete = (model: Model): Return =>
	model.isDeleting || model.sloId === null
		? { model }
		: { model: { ...model, isDeleting: true }, commands: [DeleteSlo({ sloId: model.sloId })] }

const updateChart = (
	chart: Chart.Model,
	message: Chart.Message,
	toMessage: (message: Chart.Message) => Message,
) => {
	const next = Chart.update(chart, message)
	return {
		chart: next.model,
		commands: FoldkitCommand.mapMessages(next.commands ?? [], toMessage),
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSlo: ({ key, result }) => ({
			model: { ...model, slo: Keyed.accept(model.slo, key, result) },
		}),
		CompletedFetchStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedFetchHistory: ({ key, result }) => ({
			model: { ...model, history: Keyed.accept(model.history, key, result) },
		}),
		ClickedRetry: () => requestAll(model, context, "Supersede"),
		ClickedRetryStatus: () => request(model, context, "status", "Supersede"),
		ClickedRetryHistory: () => request(model, context, "history", "Supersede"),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		UpdatedIncidents: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, incidents: rows } } : { model },
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants } } : { model },
		ClickedToggleAlerting: () => toggleAlerting(model),
		CompletedToggleAlerting: ({ result }) => {
			const settled = { ...model, isTogglingAlerting: false }
			return Result.match(result, {
				// The PATCH answers with the SLO as saved: it is the page's SLO now.
				onSuccess: (slo): Return => ({
					model: { ...settled, slo: { ...settled.slo, data: AsyncData.Success({ data: slo }) } },
					outMessage: toast(
						"success",
						slo.alerting.enabled ? "Alerting turned on" : "Alerting turned off",
					),
				}),
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: toast("error", "Couldn't update alerting", failure.message),
				}),
			})
		},
		ClickedDelete: () => updateDeleteDialog(model, Dialog.open(model.deleteDialog)),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting
				? { model }
				: updateDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
		ClickedConfirmDelete: () => confirmDelete(model),
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: (): Return => ({
					model: { ...model, isDeleting: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: slosTabHref(),
						isReplace: true,
						toast: { type: "success", title: "SLO deleted", description: "" },
					}),
				}),
				onFailure: (failure): Return => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", "Couldn't delete the SLO", failure.message),
				}),
			}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotBudgetChartMessage: ({ message: child }) => {
			const next = updateChart(model.budgetChart, child, (message) =>
				Message.GotBudgetChartMessage({ message }),
			)
			return { model: { ...model, budgetChart: next.chart }, commands: next.commands }
		},
		GotSliChartMessage: ({ message: child }) => {
			const next = updateChart(model.sliChart, child, (message) =>
				Message.GotSliChartMessage({ message }),
			)
			return { model: { ...model, sliChart: next.chart }, commands: next.commands }
		},
	})
