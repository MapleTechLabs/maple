import { type ErrorIssueId, WORKFLOW_STATE_ORDER } from "@maple/domain/http"
import { Command, type Update } from "foldkit"
import { Option } from "effect"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { AppRoute, hrefOf } from "../../../route"
import * as Menu from "../../../ui/menu"
import * as QuickPick from "../kit/quick-pick"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SEVERITY_ORDER } from "../kit/severity"
import { FetchPage, FetchServiceCounts, RunHubWrite } from "./command"
import { signalsOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { type HubWrite, outcomeToast, type WriteOutcome } from "./writes"

// The list's selection (`updateIssueSelection`), keyboard (`useListNavigation`) and the writes
// `useIssueMutations` sends from a row, a picker or the bulk bar.

type Return = PageReturn<Model, Message>

const orderedIds = (model: Model): ReadonlyArray<ErrorIssueId> => signalsOf(model).map((signal) => signal.id)

/** A toggle, or with Shift a range from the anchor (which stays put). */
export const toggledSelection = (model: Model, id: string, isShift: boolean): Model => {
	const ids = orderedIds(model)
	if (!ids.some((candidate) => candidate === id)) return model
	if (isShift && model.selectionAnchor !== null) {
		const from = ids.findIndex((candidate) => candidate === model.selectionAnchor)
		const to = ids.findIndex((candidate) => candidate === id)
		if (from !== -1 && to !== -1) {
			const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
			return { ...model, selectedIds: [...new Set([...model.selectedIds, ...range])] }
		}
	}
	return {
		...model,
		selectedIds: model.selectedIds.includes(id)
			? model.selectedIds.filter((selected) => selected !== id)
			: [...model.selectedIds, id],
		selectionAnchor: id,
	}
}

const cleared = (model: Model): Model => ({ ...model, selectedIds: [], selectionAnchor: null })

/** `j`/`k`/arrows move the focus, Enter opens, `x` selects, Escape clears; `s`/`p` open its pickers. */
export const pressedListKey = (
	model: Model,
	key: string,
	isShift: boolean,
	openPicker: (model: Model, id: string, kind: "state" | "severity") => Return,
): Return => {
	const ids = orderedIds(model)
	const current = model.focusedId === null ? -1 : ids.findIndex((id) => id === model.focusedId)
	switch (key) {
		case "j":
		case "J":
		case "ArrowDown":
		case "k":
		case "K":
		case "ArrowUp": {
			if (ids.length === 0) return { model }
			const isDown = key === "j" || key === "J" || key === "ArrowDown"
			const next = isDown
				? current < 0
					? 0
					: Math.min(current + 1, ids.length - 1)
				: current <= 0
					? 0
					: current - 1
			return { model: { ...model, focusedId: ids[next] ?? model.focusedId } }
		}
		case "Enter": {
			const focused = ids[current]
			return focused === undefined
				? { model }
				: {
						model,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefOf(AppRoute.ErrorIssue({ issueId: focused, search: {} })),
							isReplace: false,
						}),
					}
		}
		case "x":
		case "X":
			return model.focusedId === null
				? { model }
				: { model: toggledSelection(model, model.focusedId, isShift) }
		case "Escape":
			return model.selectedIds.length > 0
				? { model: cleared(model) }
				: { model: { ...model, focusedId: null } }
		case "s":
		case "S":
			return model.focusedId === null ? { model } : openPicker(model, model.focusedId, "state")
		case "p":
		case "P":
			return model.focusedId === null ? { model } : openPicker(model, model.focusedId, "severity")
		default:
			return { model }
	}
}

/** Starts a write; like `useIssueMutations` there is no per-row guard, so the newest pick is sent too. */
export const startHubWrite = (
	model: Model,
	ids: ReadonlyArray<ErrorIssueId>,
	write: HubWrite,
	isBulk: boolean,
): Return =>
	ids.length === 0
		? { model }
		: {
				model: { ...model, writingIds: [...model.writingIds, ...ids] },
				commands: [RunHubWrite({ ids, write, isBulk })],
			}

/** Drops one in-flight entry per written id (a row can have two writes out). */
const settledWriting = (writing: ReadonlyArray<string>, ids: ReadonlyArray<string>) =>
	ids.reduce((left, id) => {
		const at = left.indexOf(id)
		return at === -1 ? left : [...left.slice(0, at), ...left.slice(at + 1)]
	}, writing)

/** The bulk bar acts on the selection and clears it at once (`onClear` after each action). */
export const bulkWrite = (model: Model, write: HubWrite): Return => {
	const ids = orderedIds(model).filter((id) => model.selectedIds.includes(id))
	return startHubWrite(cleared(model), ids, write, true)
}

/** `ISSUES_KEY`: every loaded page and the sidebar's service counts are read again. */
type PageQuery = (model: Model, cursor: string | null) => Parameters<typeof FetchPage>[0]["query"]

const refreshIssues = (model: Model, context: PageContext, pageQuery: PageQuery): Return => {
	// Invalidation restarts reads already in flight: an answer from before the write is dropped.
	const pages = model.pages.map((slot) => {
		if (slot.page.key === null) return { slot, command: Option.none<typeof slot>() }
		const next = { ...slot, page: Keyed.supersede(slot.page, slot.page.key) }
		return { slot: next, command: Option.some(next) }
	})
	const counts = Option.some(
		Keyed.supersede(model.serviceCounts, requestKey(context.orgId, "errorIssues.serviceCounts", {})),
	)
	return {
		model: {
			...model,
			pages: pages.map(({ slot }) => slot),
			serviceCounts: Option.getOrElse(counts, () => model.serviceCounts),
		},
		commands: [
			...pages.flatMap(({ command }) =>
				Option.match(command, {
					onNone: () => [],
					onSome: (slot) =>
						slot.page.key === null
							? []
							: [FetchPage({ key: slot.page.key, query: pageQuery(model, slot.cursor) })],
				}),
			),
			...Option.match(counts, {
				onNone: () => [],
				onSome: (slot) => (slot.key === null ? [] : [FetchServiceCounts({ key: slot.key })]),
			}),
		],
	}
}

export const completedHubWrite = (
	model: Model,
	context: PageContext,
	ids: ReadonlyArray<string>,
	write: HubWrite,
	isBulk: boolean,
	outcome: WriteOutcome,
	pageQuery: PageQuery,
): Return => {
	const settled = { ...model, writingIds: settledWriting(model.writingIds, ids) }
	const toast = outcomeToast(write, outcome, isBulk)
	if (outcome.succeeded === 0) return { model: settled, outMessage: toast }
	// Only the bulk bar clears the selection, when it is clicked (`bulkWrite`); a row's write keeps it.
	const refreshed = refreshIssues(settled, context, pageQuery)
	return { ...refreshed, outMessage: toast }
}

/** The bulk bar's menus: a picked severity or state writes the selection. */
export const bulkMenuStep = (
	model: Model,
	which: "bulkSeverityMenu" | "bulkMoveMenu",
	message: Menu.Message,
): Return => {
	const next: Update.ReturnWithOutMessage<Menu.Model, Menu.Message, Menu.OutMessage> = Menu.update(
		model[which],
		message,
	)
	const wrap = (inner: Menu.Message) =>
		which === "bulkSeverityMenu"
			? Message.GotBulkSeverityMenuMessage({ message: inner })
			: Message.GotBulkMoveMenuMessage({ message: inner })
	const lifted: Return = {
		model: { ...model, [which]: next.model },
		commands: Command.mapMessages(next.commands ?? [], wrap),
	}
	if (next.outMessage?._tag !== "SelectedItem") return lifted
	const value = next.outMessage.value
	const write: HubWrite | null =
		which === "bulkSeverityMenu"
			? { _tag: "SetSeverity", severity: SEVERITY_ORDER.find((severity) => severity === value) ?? null }
			: Option.match(Option.fromNullishOr(WORKFLOW_STATE_ORDER.find((state) => state === value)), {
					onNone: () => null,
					onSome: (toState) => ({ _tag: "Transition", toState }),
				})
	if (write === null) return lifted
	const written = bulkWrite(lifted.model, write)
	return { ...written, commands: [...(lifted.commands ?? []), ...(written.commands ?? [])] }
}

/** `openPicker`: one picker across the list, on this row; a second press of its trigger closes it. */
export const openedPicker = (model: Model, id: string, kind: "state" | "severity"): Return =>
	model.picker !== null && model.picker.issueId === id && model.picker.kind === kind
		? { model: { ...model, picker: null } }
		: {
				model: {
					...model,
					picker: { issueId: id, kind, quickPick: QuickPick.init(`errors-picker-${kind}-${id}`) },
				},
			}

/** A pick writes that row (when it changed); closing drops the picker. */
export const pickerStep = (model: Model, message: QuickPick.Message): Return => {
	const picker = model.picker
	if (picker === null) return { model }
	const next = QuickPick.update(picker.quickPick, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotPickerMessage({ message: inner }),
	)
	if (next.outMessage === undefined)
		return { model: { ...model, picker: { ...picker, quickPick: next.model } }, commands }
	const closed = { ...model, picker: null }
	if (next.outMessage._tag === "Closed") return { model: closed, commands }
	const value = next.outMessage.value
	const signal = signalsOf(model).find((candidate) => candidate.id === picker.issueId)
	if (signal === undefined) return { model: closed, commands }
	const write: HubWrite | null =
		picker.kind === "severity"
			? value === (signal.severity ?? "none")
				? null
				: {
						_tag: "SetSeverity",
						severity: SEVERITY_ORDER.find((severity) => severity === value) ?? null,
					}
			: value === signal.issue.workflowState
				? null
				: Option.match(Option.fromNullishOr(WORKFLOW_STATE_ORDER.find((state) => state === value)), {
						onNone: () => null,
						onSome: (toState) => ({ _tag: "Transition", toState }),
					})
	if (write === null) return { model: closed, commands }
	const written = startHubWrite(closed, [signal.id], write, false)
	return { ...written, commands: [...commands, ...(written.commands ?? [])] }
}
