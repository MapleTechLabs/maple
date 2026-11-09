import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	CHAIN_IN_USE_CODE,
	chainHref,
	chainIdFromUrl,
	routingTabHref,
	safeReturnTo,
} from "../shared/escalation-chains"
import {
	DeleteChain,
	FetchChainEditorMembers,
	FetchChainEditorSchedules,
	FetchChainEditorSession,
	FetchExistingChain,
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
	moveStep,
	payloadOf,
	removeStep,
	removeTarget,
	targetOfKey,
} from "./form"
import { Message, type MenuKind } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
export type ChainRoute = Extract<
	AppRoute,
	{ readonly _tag: "AlertsEscalationChainNew" } | { readonly _tag: "AlertsEscalationChain" }
>

export const DELETE_DIALOG_ID = "escalation-chain-delete"

export const menuIdOf = (kind: MenuKind, key: string): string => `escalation-chain-${kind}-${key}`

/** Where Cancel goes: the `returnTo` the link carried, else the Routing section. */
export const backHref = (model: Pick<Model, "search">): string =>
	Option.getOrElse(safeReturnTo(model.search.returnTo), routingTabHref)

export const init = (route: ChainRoute, context: PageContext): Return => {
	const rawId = route._tag === "AlertsEscalationChain" ? Option.some(route.chainId) : Option.none()
	const editingId = Option.getOrNull(Option.flatMap(rawId, chainIdFromUrl))
	const model: Model = {
		search: route.search,
		editingId,
		isBadId: Option.isSome(rawId) && editingId === null,
		existing: Keyed.idle(),
		form: emptyForm,
		destinations: null,
		rules: null,
		members: null,
		schedules: null,
		menus: {},
		isSaving: false,
		isShowingErrors: false,
		saveFailure: null,
		deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
		isDeleting: false,
		deleteError: null,
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

/** A form edit is dropped while a save is in flight: the saved chain is what the page shows. */
const withForm = (model: Model, edit: (form: Form) => Form): Return =>
	model.isSaving ? { model } : { model: { ...model, form: edit(model.form) } }

const stepAction = (form: Form, key: string, value: string): Form => {
	switch (value) {
		case "up":
			return moveStep(form, key, "up")
		case "down":
			return moveStep(form, key, "down")
		case "duplicate":
			return duplicateStep(form, key)
		case "remove":
			return removeStep(form, key)
		default:
			return form
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
	return Option.match(model.isSaving ? Option.none() : picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (value) =>
			kind === "actions"
				? { model: { ...next, form: stepAction(next.form, key, value) }, commands }
				: Option.match(targetOfKey(value), {
						onNone: () => ({ model: next, commands }),
						onSome: (target) => ({
							model: { ...next, form: addTarget(next.form, key, target) },
							commands,
						}),
					}),
	})
}

const save = (model: Model): Return =>
	model.isSaving
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

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchExisting: ({ key, result }) => {
			const existing = Keyed.accept(model.existing, key, result)
			// The form fills once, from the first read.
			const isFirst = !AsyncData.isSuccess(model.existing.data)
			return {
				model: Result.match(result, {
					onSuccess: (chain) => ({
						...model,
						existing,
						form: isFirst ? formFromChain(chain) : model.form,
					}),
					onFailure: () => ({ ...model, existing }),
				}),
			}
		},
		ClickedRetryExisting: () => {
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
		},
		UpdatedDestinations: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, destinations: rows } } : { model },
		UpdatedRules: ({ orgId, rows }) =>
			orgId === context.orgId ? { model: { ...model, rules: rows } } : { model },
		// Without members a person reads "Member"; destinations and schedules still show.
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members } }),
				onFailure: () => ({ model: { ...model, members: [] } }),
			}),
		CompletedFetchSchedules: ({ result }) =>
			Result.match(result, {
				onSuccess: (schedules) => ({ model: { ...model, schedules } }),
				onFailure: () => ({ model: { ...model, schedules: [] } }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants, isSessionLoaded: true } } : { model },
		ChangedName: ({ value }) => withForm(model, (form) => ({ ...form, name: value })),
		ChangedDescription: ({ value }) => withForm(model, (form) => ({ ...form, description: value })),
		ChangedRepeatCount: ({ value }) => withForm(model, (form) => ({ ...form, repeatCount: value })),
		ChangedWait: ({ key, value }) =>
			withForm(model, (form) => editStep(form, key, (step) => ({ ...step, waitMinutes: value }))),
		ClickedInsertStep: ({ index }) => withForm(model, (form) => insertStep(form, index)),
		ClickedRemoveStep: ({ key }) => withForm(model, (form) => removeStep(form, key)),
		ClickedDuplicateStep: ({ key }) => withForm(model, (form) => duplicateStep(form, key)),
		ClickedMoveStep: ({ key, direction }) => withForm(model, (form) => moveStep(form, key, direction)),
		GotMenuMessage: ({ kind, key, message: child }) => stepMenu(model, kind, key, child),
		ClickedRemoveTarget: ({ key, target }) => withForm(model, (form) => removeTarget(form, key, target)),
		ClickedSave: () => save(model),
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (chain): Return => ({
					model: { ...model, isSaving: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: Option.getOrElse(safeReturnTo(model.search.returnTo), () => chainHref(chain.id)),
						isReplace: true,
						toast: {
							type: "success",
							title:
								model.editingId === null
									? "Escalation chain created"
									: "Escalation chain saved",
							description: "",
						},
					}),
				}),
				onFailure: (failure): Return => ({
					model: { ...model, isSaving: false, saveFailure: failure },
				}),
			}),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDelete(model, Dialog.update(model.deleteDialog, child)),
		ClickedDelete: () =>
			model.editingId === null
				? { model }
				: liftDelete({ ...model, deleteError: null }, Dialog.open(model.deleteDialog)),
		ClickedConfirmDelete: () =>
			model.editingId === null || model.isDeleting
				? { model }
				: {
						model: { ...model, isDeleting: true, deleteError: null },
						commands: [DeleteChain({ chainId: model.editingId })],
					},
		CompletedDelete: ({ result }) =>
			Result.match(result, {
				onSuccess: (): Return => ({
					model: { ...model, isDeleting: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: routingTabHref(),
						isReplace: true,
						toast: { type: "success", title: "Escalation chain deleted", description: "" },
					}),
				}),
				onFailure: (failure): Return => ({
					model: {
						...model,
						isDeleting: false,
						deleteError:
							failure.code === CHAIN_IN_USE_CODE
								? "An alert rule still starts this chain. Remove it from the rule's severity tiers first."
								: failure.message,
					},
				}),
			}),
	})
