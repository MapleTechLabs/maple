import { InvestigationId } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import { modifyFields } from "foldkit/struct"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as Tooltip from "../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	FetchEscalation,
	FetchSignalLogs,
	CheckTipFocus,
	FetchSignalTraces,
	ReadInvestigationClock,
	ResolveInvestigation,
	RestartInvestigation,
} from "./command"
import { investigationOf, openActionIndexOf, signalServiceOf, signalWindowOf, tabOf } from "./derive"
import { graphOf, placeGraph } from "./graph"
import { followConversation, openReportAction, stepConversation, stepReportSheet } from "./conversation"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type InvestigationRoute = Extract<AppRoute, { readonly _tag: "Investigation" }>

const decodeId = Schema.decodeUnknownOption(InvestigationId)

const slotStep = <A>(
	model: Model,
	slot: Keyed.Keyed<A, LoadFailure>,
	write: (next: Keyed.Keyed<A, LoadFailure>) => Partial<Model>,
	key: string,
	command: Commands[number],
): Return =>
	Option.match(Keyed.request(slot, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (next) => ({ model: { ...model, ...write(next) }, commands: [command] }),
	})

const chain = (first: Return, next: (model: Model) => Return): Return => {
	const second = next(first.model)
	return {
		model: second.model,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

/** What the Overview tab reads once it renders: the signals card's two reads, and the escalation. */
const followOverview = (model: Model, context: PageContext): Return =>
	Option.match(investigationOf(model), {
		onNone: () => ({ model }),
		onSome: (investigation) => {
			const window = signalWindowOf(investigation)
			const service = signalServiceOf(investigation)
			const signals: Return =
				tabOf(model) !== "overview" || window === null || service === null
					? { model }
					: chain(
							(() => {
								// `getServiceOverviewResultAtom` is `globalNamespace: "top"`.
								const namespaces = context.pinnedNamespace === null ? undefined : [context.pinnedNamespace]
								const input = { startTime: window.startTime, endTime: window.endTime, namespaces }
								const key = requestKey(context.orgId, "getServiceOverview", input)
								return slotStep(model, model.traces, (traces) => ({ traces }), key, FetchSignalTraces({ key, ...input }))
							})(),
							(next) => {
								const key = requestKey(context.orgId, "getCustomChartTimeSeries", { service, window })
								return slotStep(next, next.logs, (logs) => ({ logs }), key, FetchSignalLogs({ key, service, window }))
							},
						)
			const issueId = investigation.subject.type === "incident" ? investigation.subject.issue_id : null
			if (issueId === null || tabOf(model) === "chat" || tabOf(model) === "transcript") return signals
			return chain(signals, (next) => {
				const key = requestKey(context.orgId, "errors.listIssueEscalations", { issueId })
				return slotStep(next, next.escalation, (escalation) => ({ escalation }), key, FetchEscalation({ key, issueId, investigationId: investigation.id }))
			})
		},
	})

/** `ProvenanceCanvas` holds the sheet: it opens only on Overview, for an action the graph drew. */
const hasOpenAction = (model: Model, timeZone: string): boolean => {
	const index = openActionIndexOf(model)
	return (
		index !== null &&
		tabOf(model) === "overview" &&
		Option.exists(investigationOf(model), (investigation) =>
			graphOf(investigation, timeZone).nodes.some((node) => node.type === "action" && node.data.index === index),
		)
	)
}

const sheetFor = (model: Model, timeZone: string): Return => {
	const isOpen = hasOpenAction(model, timeZone)
	if (isOpen === model.actionSheet.isOpen) return { model }
	const step = isOpen ? Dialog.open(model.actionSheet) : Dialog.close(model.actionSheet)
	return {
		model: { ...model, actionSheet: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotActionSheetMessage({ message })),
	}
}

export const init = (route: InvestigationRoute, _context: PageContext): Return => {
	const model: Model = {
		id: route.id,
		search: route.search,
		nowMs: 0,
		sync: Option.isNone(decodeId(route.id)) ? { _tag: "Missing" } : { _tag: "Loading" },
		syncAttempt: 0,
		logs: Keyed.idle(),
		traces: Keyed.idle(),
		escalation: Keyed.idle(),
		busy: null,
		actionsMenu: Menu.init("investigation-actions"),
		actionSheet: Dialog.init("investigation-action-sheet", "sheet", { isOpen: false }),
		canvas: Canvas.init({ minZoom: 0.3, maxZoom: 1.4, fitOnInit: Option.none() }),
		traceTooltip: Tooltip.init("investigation-trace-tooltip"),
		conversation: null,
		reportActionIndex: null,
		reportSheet: Dialog.init("investigation-report-sheet", "sheet", { isOpen: false }),
		knownServices: null,
	}
	return { model, commands: [ReadInvestigationClock()] }
}

export const routeChanged = (model: Model, route: InvestigationRoute, context: PageContext): Return =>
	chain(chain(followOverview({ ...model, search: route.search }, context), (next) => sheetFor(next, context.timeZone)), (next) =>
		followConversation(next, context),
	)

/** A pin change re-keys the signals card's overview read. */
export const contextChanged = (model: Model, context: PageContext): Return => followOverview(model, context)

const navigateSearch = (model: Model, search: Model["search"], isReplace: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Investigation({ id: model.id, search })), isReplace }),
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const isResolved = (model: Model) => Option.exists(investigationOf(model), (investigation) => investigation.status === "resolved")

const startWrite = (model: Model, kind: "resolve" | "restart"): Return =>
	model.busy !== null
		? { model }
		: Option.match(decodeId(model.id), {
				onNone: () => ({ model }),
				onSome: (id) => ({
					model: { ...model, busy: kind },
					commands: [kind === "resolve" ? ResolveInvestigation({ id }) : RestartInvestigation({ id })],
				}),
			})

/** The camera is the reader's again: a new graph, or the fit button. */
const replace = (model: Model, timeZone: string): Model =>
	placeGraph(modifyFields(model, { canvas: (canvas) => ({ ...canvas, movedByUser: false }) }), timeZone)

/** The header's primary button, by status (`InvestigationActions`). */
const primaryKind = (investigation: V2Investigation): "resolve" | "restart" =>
	investigation.status === "failed" || investigation.status === "inconclusive" || investigation.status === "resolved"
		? "restart"
		: "resolve"

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		TickedClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		SyncedInvestigation: ({ orgId, id, attempt, sync }) => {
			if (orgId !== context.orgId || id !== model.id || attempt !== model.syncAttempt) return { model }
			const next = { ...model, sync }
			return chain(
				chain(chain(followOverview(next, context), (opened) => sheetFor(opened, context.timeZone)), (placed) => ({ model: replace(placed, context.timeZone) })),
				(placed) => followConversation(placed, context),
			)
		},
		CompletedFetchLogs: ({ key, result }) => ({ model: { ...model, logs: Keyed.accept(model.logs, key, result) } }),
		CompletedFetchTraces: ({ key, result }) => ({ model: { ...model, traces: Keyed.accept(model.traces, key, result) } }),
		CompletedFetchEscalation: ({ key, result }) => ({ model: { ...model, escalation: Keyed.accept(model.escalation, key, result) } }),
		ClickedPrimary: () =>
			Option.match(investigationOf(model), {
				onNone: () => ({ model }),
				onSome: (investigation) => startWrite(model, primaryKind(investigation)),
			}),
		// `retryOrgCollections` mints a fresh scoped collection; the bumped attempt resubscribes onto one.
		ClickedRetrySync: () => ({ model: { ...model, sync: { _tag: "Loading" }, syncAttempt: model.syncAttempt + 1 } }),
		CompletedResolve: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({ model: { ...model, busy: null }, outMessage: toast("success", "Investigation resolved") }),
				onFailure: (failure) => ({ model: { ...model, busy: null }, outMessage: toast("error", "Couldn't resolve investigation", failure.message) }),
			}),
		CompletedRestart: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, busy: null },
					outMessage: toast("success", isResolved(model) ? "Investigation reopened" : "Investigation restarted"),
				}),
				onFailure: (failure) => ({
					model: { ...model, busy: null },
					outMessage: toast("error", isResolved(model) ? "Couldn't reopen investigation" : "Couldn't restart investigation", failure.message),
				}),
			}),
		ClickedFollowUp: () => navigateSearch(model, { tab: "chat" }, false),
		ClickedAction: ({ index }) => {
			const tab = tabOf(model)
			return navigateSearch(model, { tab: tab === "overview" ? undefined : tab, action: index }, true)
		},
		ClickedNodeLink: ({ href }) => ({ model, outMessage: PageOutMessage.RequestedNavigation({ url: href, isReplace: false }) }),
		ClickedPlaceGraph: () => ({ model: replace(model, context.timeZone) }),
		GotActionsMenuMessage: ({ message: inner }) => {
			const next = Menu.update(model.actionsMenu, inner)
			const updated: Return = {
				model: { ...model, actionsMenu: next.model },
				commands: Command.mapMessages(next.commands ?? [], (menu) => Message.GotActionsMenuMessage({ message: menu })),
			}
			if (next.outMessage?._tag !== "SelectedItem") return updated
			const kind = next.outMessage.value === "resolve" ? "resolve" : "restart"
			return chain(updated, (after) => startWrite(after, kind))
		},
		GotActionSheetMessage: ({ message: inner }) => {
			const step = Dialog.update(model.actionSheet, inner)
			const updated: Return = {
				model: { ...model, actionSheet: step.model },
				commands: Command.mapMessages(step.commands ?? [], (sheet) => Message.GotActionSheetMessage({ message: sheet })),
			}
			if (step.outMessage?._tag !== "Closed") return updated
			const tab = tabOf(model)
			return { ...updated, outMessage: navigateSearch(model, { tab: tab === "overview" ? undefined : tab }, true).outMessage }
		},
		GotTraceTooltipMessage: ({ message: inner }) => {
			// A focus opens the tip only once `:focus-visible` confirms it was the keyboard's.
			const isFocus = inner._tag === "FocusedTrigger"
			const step = isFocus ? { model: model.traceTooltip, commands: [] } : Tooltip.update(model.traceTooltip, inner)
			// The chip is a link: the root's intent preload warms its trace route (`page/preload.ts`).
			return {
				model: { ...model, traceTooltip: step.model },
				commands: [
					...Command.mapMessages(step.commands ?? [], (tooltip) => Message.GotTraceTooltipMessage({ message: tooltip })),
					...(inner._tag === "FocusedTrigger" ? [CheckTipFocus({ triggerId: inner.triggerId })] : []),
				],
			}
		},
		CheckedTipFocus: ({ triggerId, isFocusVisible }) => {
			if (!isFocusVisible) return { model }
			const step = Tooltip.update(model.traceTooltip, Tooltip.Message.CheckedFocusVisible({ triggerId, isFocusVisible: true }))
			return {
				model: { ...model, traceTooltip: step.model },
				commands: Command.mapMessages(step.commands ?? [], (tooltip) => Message.GotTraceTooltipMessage({ message: tooltip })),
			}
		},
		CompletedLoadKnownServices: ({ services }) => ({ model: { ...model, knownServices: services } }),
		GotConversationMessage: ({ message: inner }) => stepConversation(model, inner),
		ClickedReportAction: ({ index }) => openReportAction(model, index),
		GotReportSheetMessage: ({ message: inner }) => stepReportSheet(model, inner),
		CompletedMountScroller: () => ({ model }),
		GotCanvasMessage: ({ message: inner }) => {
			const updated = Canvas.update(model.canvas, inner, [])
			const isZoom = inner._tag === "ClickedZoomIn" || inner._tag === "ClickedZoomOut"
			const canvas = isZoom ? { ...updated, movedByUser: true } : updated
			const next = { ...model, canvas }
			return { model: inner._tag === "ResizedPane" && !canvas.movedByUser ? placeGraph(next, context.timeZone) : next }
		},
	})
