import { Option, Result, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { triggerId } from "@maple/views/ui/overlay/popup-state"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	CHAIN_IN_USE_CODE,
	CHAIN_NOT_FOUND_CODE,
	chainIdFromUrl,
	routingTabHref,
} from "../shared/escalation-chains"
import {
	DeleteChain,
	FetchChainEditorMembers,
	FetchChainEditorSchedules,
	FetchChainEditorSession,
	FetchExistingChain,
	FocusChainElement,
	SaveChain,
} from "./command"
import {
	addTarget,
	duplicateStep,
	editStep,
	emptyForm,
	type Form,
	formFromChain,
	insertStep,
	isSameChain,
	moveStep,
	payloadOf,
	removeStep,
	removeTarget,
	targetOfKey,
} from "./form"
import { Message, type MenuKind } from "./message"
import { canManage, type Model } from "./model"

type Return = PageReturn<Model, Message>
export type ChainRoute = Extract<
	AppRoute,
	{ readonly _tag: "AlertsEscalationChainNew" } | { readonly _tag: "AlertsEscalationChain" }
>

export const DELETE_DIALOG_ID = "escalation-chain-delete"
export const LEAVE_DIALOG_ID = "escalation-chain-leave"

export const menuIdOf = (kind: MenuKind, key: string): string => `escalation-chain-${kind}-${key}`

/** The + on the connector above the step at `index` (or below the last one). */
export const insertButtonId = (index: number): string => `escalation-chain-insert-${index}`

/** Where Cancel, Save and Delete go back to. */
export const backHref = (): string => routingTabHref()

export const init = (route: ChainRoute, context: PageContext): Return => {
	const rawId = route._tag === "AlertsEscalationChain" ? Option.some(route.chainId) : Option.none()
	const editingId = Option.getOrNull(Option.flatMap(rawId, chainIdFromUrl))
	const model: Model = {
		editingId,
		isBadId: Option.isSome(rawId) && editingId === null,
		existing: Keyed.idle(),
		form: emptyForm,
		baseline: emptyForm,
		destinations: null,
		rules: null,
		members: null,
		schedules: null,
		isSchedulesFailed: false,
		brokenLogos: [],
		menus: {},
		isSaving: false,
		isShowingErrors: false,
		saveFailure: null,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
		isDeleting: false,
		deleteError: null,
		leaveDialog: Dialog.init(LEAVE_DIALOG_ID, "alert-dialog"),
		pendingLeaveUrl: null,
		grants: [],
		isSessionLoaded: false,
	}
	const common = [
		FetchChainEditorMembers(),
		FetchChainEditorSchedules(),
		FetchChainEditorSession({ orgId: context.orgId }),
	]
	if (editingId === null) return { model, commands: common }
	const key = requestKey(context.orgId, "escalationChains.retrieve", { id: editingId })
	return Option.match(Keyed.request(model.existing, key, "Load"), {
		onNone: () => ({ model, commands: common }),
		onSome: (existing) => ({
			model: { ...model, existing },
			commands: [...common, FetchExistingChain({ key, chainId: editingId })],
		}),
	})
}

/** Reads the chain again (a retry, or a refused delete whose rule list may have moved). */
const refetch = (model: Model, context: PageContext): Return => {
	const editingId = model.editingId
	if (editingId === null) return { model }
	const key = requestKey(context.orgId, "escalationChains.retrieve", { id: editingId })
	return Option.match(Keyed.request(model.existing, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (existing) => ({
			model: { ...model, existing },
			commands: [FetchExistingChain({ key, chainId: editingId })],
		}),
	})
}

// LEAVING

/** The form holds edits a save has not sent. */
export const isDirty = (model: Pick<Model, "form" | "baseline">): boolean =>
	!isSameChain(model.form, model.baseline)

/** Leaving with unsaved edits asks first; a save or delete in flight is on its way out already. */
export const isBlockingNavigation = (model: Model): boolean =>
	!model.isSaving && !model.isDeleting && canManage(model) && isDirty(model)

const navigate = (model: Model, url: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
})

/** A save or delete went through: back to Routing in place of this page, with its toast. */
const finished = (model: Model, title: string): Return => ({
	// The form is what was saved (or is gone): nothing left to ask about on the way out.
	model: { ...model, isSaving: false, isDeleting: false, baseline: model.form },
	outMessage: PageOutMessage.RequestedNavigation({
		url: backHref(),
		isReplace: true,
		toast: { type: "success", title, description: "" },
	}),
})

/** The confirmation over a held navigation (a link, Back, or Cancel). */
export const askToLeave = (model: Model, url: string): Return => {
	const next = Dialog.open(model.leaveDialog)
	return {
		model: { ...model, leaveDialog: next.model, pendingLeaveUrl: url },
		commands: FoldkitCommand.mapMessages(next.commands ?? [], (message) =>
			Message.GotLeaveDialogMessage({ message }),
		),
	}
}

const leave = (model: Model, url: string): Return =>
	isBlockingNavigation(model) ? askToLeave(model, url) : navigate(model, url)

// STEP EDITS

/** A form edit is dropped while a save is in flight, and for a viewer who may not change chains. */
const canEdit = (model: Model): boolean => !model.isSaving && canManage(model)

const withForm = (model: Model, edit: (form: Form) => Form): Return =>
	canEdit(model) ? { model: { ...model, form: edit(model.form) } } : { model }

const focus = (id: string) => [FocusChainElement({ id })]

/** A step that was just added: focus lands on its "Add" button, so its targets come next. */
const added = (model: Model, form: Form): Return =>
	form.nextKey === model.form.nextKey
		? { model }
		: {
				model: { ...model, form },
				commands: focus(triggerId(menuIdOf("targets", `s${model.form.nextKey}`))),
			}

/** A removed step hands focus to the step before it, or to the + that now leads the chain. */
const removed = (model: Model, key: string): Return => {
	const form = removeStep(model.form, key)
	if (form.steps.length === model.form.steps.length) return { model }
	const index = Option.getOrElse(
		Arr.findFirstIndex(model.form.steps, (step) => step.key === key),
		() => 0,
	)
	const previous = index === 0 ? undefined : model.form.steps[index - 1]
	return {
		model: { ...model, form },
		commands: focus(
			previous === undefined ? insertButtonId(0) : triggerId(menuIdOf("actions", previous.key)),
		),
	}
}

const stepAction = (model: Model, key: string, value: string): Return => {
	switch (value) {
		case "up":
		case "down":
			return {
				model: { ...model, form: moveStep(model.form, key, value) },
				commands: focus(triggerId(menuIdOf("actions", key))),
			}
		case "duplicate":
			return added(model, duplicateStep(model.form, key))
		case "remove":
			return removed(model, key)
		default:
			return { model }
	}
}

/** A step's menus: a target pick adds it to the step, an action edits the steps. */
const stepMenu = (model: Model, kind: MenuKind, key: string, message: Menu.Message): Return => {
	const id = menuIdOf(kind, key)
	const result = Menu.update(model.menus[id] ?? Menu.init(id), message)
	const next: Model = { ...model, menus: { ...model.menus, [id]: result.model } }
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotMenuMessage({ kind, key, message: child }),
	)
	const picked =
		result.outMessage?._tag === "SelectedItem" ? Option.some(result.outMessage.value) : Option.none()
	// The menus still open and close while saving, but a pick no longer edits the chain.
	return Option.match(canEdit(model) ? picked : Option.none(), {
		onNone: () => ({ model: next, commands }),
		onSome: (value) => {
			if (kind === "actions") {
				const acted = stepAction(next, key, value)
				return { model: acted.model, commands: [...commands, ...(acted.commands ?? [])] }
			}
			return Option.match(targetOfKey(value), {
				onNone: () => ({ model: next, commands }),
				onSome: (target) => ({
					model: { ...next, form: addTarget(next.form, key, target) },
					commands,
				}),
			})
		},
	})
}

const save = (model: Model): Return =>
	!canEdit(model)
		? { model }
		: Option.match(payloadOf(model.form), {
				onNone: () => ({ model: { ...model, isShowingErrors: true } }),
				onSome: (payload) => ({
					model: { ...model, isSaving: true, isShowingErrors: true, saveFailure: null },
					commands: [SaveChain({ editingId: model.editingId, payload })],
				}),
			})

const liftDelete = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		deleteError: step.model.isOpen ? model.deleteError : null,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const deleted = (model: Model): Return => finished(model, "Escalation chain deleted")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			// The form fills once, from the first read; a later read only refreshes who uses the chain.
			const isFirst = Option.isNone(AsyncData.getData(model.existing.data))
			return {
				model: Result.match(result, {
					onSuccess: (chain) =>
						isFirst
							? {
									...model,
									existing,
									form: formFromChain(chain),
									baseline: formFromChain(chain),
								}
							: { ...model, existing },
					onFailure: () => ({ ...model, existing }),
				}),
			}
		},
		ClickedRetryExisting: () => refetch(model, context),
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		UpdatedRules: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, rules: rows } } : { model },
		// Without members a person reads "Member"; destinations and schedules still show.
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members } }),
				onFailure: () => ({ model }),
			}),
		CompletedFetchSchedules: ({ result }) =>
			Result.match(result, {
				onSuccess: (schedules) => ({ model: { ...model, schedules, isSchedulesFailed: false } }),
				onFailure: () => ({ model: { ...model, isSchedulesFailed: true } }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants, isSessionLoaded: true } } : { model },
		ChangedName: ({ value }) => withForm(model, (form) => ({ ...form, name: value })),
		ChangedDescription: ({ value }) => withForm(model, (form) => ({ ...form, description: value })),
		ChangedRepeatCount: ({ value }) => withForm(model, (form) => ({ ...form, repeatCount: value })),
		ChangedWait: ({ key, value }) =>
			withForm(model, (form) => editStep(form, key, (step) => ({ ...step, waitMinutes: value }))),
		ClickedInsertStep: ({ index }) =>
			canEdit(model) ? added(model, insertStep(model.form, index)) : { model },
		GotMenuMessage: ({ kind, key, message: child }) => stepMenu(model, kind, key, child),
		ClickedRemoveTarget: ({ key, target }) => withForm(model, (form) => removeTarget(form, key, target)),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				// Back to Routing, as the rule editor goes back to Rules: the list shows the saved chain.
				onSuccess: (): Return =>
					finished(
						model,
						model.editingId === null ? "Escalation chain created" : "Escalation chain saved",
					),
				onFailure: (failure): Return => ({
					model: { ...model, isSaving: false, saveFailure: failure },
				}),
			}),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDelete(model, Dialog.update(model.deleteDialog, child)),
		ClickedDelete: () =>
			model.editingId === null || !canManage(model)
				? { model }
				: liftDelete({ ...model, deleteError: null }, Dialog.open(model.deleteDialog)),
		ClickedConfirmDelete: () =>
			model.editingId === null || model.isDeleting || !canManage(model)
				? { model }
				: {
						model: { ...model, isDeleting: true, deleteError: null },
						commands: [DeleteChain({ chainId: model.editingId })],
					},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: (): Return => deleted(model),
				onFailure: (failure): Return => {
					// Someone else deleted it first: the outcome the viewer asked for.
					if (failure.code === CHAIN_NOT_FOUND_CODE) return deleted(model)
					const settled = { ...model, isDeleting: false }
					// A rule took the chain since this page read it: read it again, so the dialog
					// lists the rule and holds its Delete.
					return failure.code === CHAIN_IN_USE_CODE
						? refetch(
								{
									...settled,
									deleteError:
										"An alert rule still starts this chain. Remove it from the rule's severity tiers first.",
								},
								context,
							)
						: { model: { ...settled, deleteError: failure.message } }
				},
			}),
		ClickedCancel: () => leave(model, backHref()),
		GotLeaveDialogMessage: ({ message: child }) => {
			const next = Dialog.update(model.leaveDialog, child)
			return {
				model: { ...model, leaveDialog: next.model },
				commands: FoldkitCommand.mapMessages(next.commands ?? [], (inner) =>
					Message.GotLeaveDialogMessage({ message: inner }),
				),
			}
		},
		ClickedDiscard: () => {
			const closed = Dialog.close(model.leaveDialog)
			return {
				...navigate(
					{ ...model, leaveDialog: closed.model, baseline: model.form },
					model.pendingLeaveUrl ?? backHref(),
				),
				commands: FoldkitCommand.mapMessages(closed.commands ?? [], (inner) =>
					Message.GotLeaveDialogMessage({ message: inner }),
				),
			}
		},
		FailedLoadProviderLogo: ({ type }) =>
			model.brokenLogos.includes(type)
				? { model }
				: { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
		CompletedFocus: () => ({ model }),
	})
