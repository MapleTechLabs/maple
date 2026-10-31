import type { ScrapeTargetId } from "@maple/domain/http"
import { ScrapeIntervalSeconds } from "@maple/domain/http"
import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { Option, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import { requestKey } from "../../data/request-key"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as Menu from "../../ui/menu"
import * as Select from "../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	DeleteTarget,
	emptyForm,
	FetchChecks,
	type FormFieldName,
	hostnameOf,
	type PrometheusCardModel,
	ProbeTarget,
	SaveTarget,
	type ScrapeForm,
	ToggleTarget,
} from "./prometheus"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"

// `ScrapeTargetsSection`'s state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<PrometheusCardModel>): Model => ({
	...model,
	prometheusCard: { ...model.prometheusCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

const refreshTargets = (model: Model, context: PageContext): Return =>
	requestStatus(model, context, "scrapeTargets", "Supersede")

/** The prometheus targets (`sourceFilter`), as the list read answered them. */
export const prometheusTargets = (model: Model): ReadonlyArray<V2ScrapeTarget> =>
	Option.match(AsyncData.getData(model.statuses.scrapeTargets.data), {
		onNone: () => [],
		onSome: (targets) => targets.filter((target) => target.target_type === "prometheus"),
	})

const targetOf = (model: Model, id: ScrapeTargetId) =>
	prometheusTargets(model).find((target) => target.id === id)

const checksKey = (context: PageContext, id: ScrapeTargetId) =>
	requestKey(context.orgId, "scrapeTargets.listChecks", { id })

export const requestChecks = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const id = model.prometheusCard.selectedId
	if (id === null) return { model }
	const key = checksKey(context, id)
	return Option.match(Keyed.request(model.prometheusCard.checks, key, mode), {
		onNone: () => ({ model }),
		onSome: (checks) => ({ model: withCard(model, { checks }), commands: [FetchChecks({ key, id })] }),
	})
}

export const clickedTarget = (model: Model, context: PageContext, id: ScrapeTargetId): Return =>
	requestChecks(withCard(model, { selectedId: id }), context, "Load")

const without = (ids: ReadonlyArray<ScrapeTargetId>, id: ScrapeTargetId) =>
	ids.filter((entry) => entry !== id)

export const clickedProbe = (model: Model, id: ScrapeTargetId): Return =>
	model.prometheusCard.probing.includes(id)
		? { model }
		: {
				model: withCard(model, { probing: [...model.prometheusCard.probing, id] }),
				commands: [ProbeTarget({ id })],
			}

/** `probe`: invalidated by its `reactivityKeys`, then refreshed again, then the verdict toast. */
export const completedProbe = (
	model: Model,
	context: PageContext,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
	success: boolean,
	error: string | null,
): Return => {
	const outcome = failure === null ? { success, error } : { success: false, error: failure.message }
	const settled = withCard(model, {
		probing: without(model.prometheusCard.probing, id),
		probes: { ...model.prometheusCard.probes, [id]: outcome },
	})
	if (failure !== null) return toast(settled, "error", "Couldn't test connection", failure.message)
	return chain(settled, [
		(next) => refreshTargets(next, context),
		(next) =>
			success
				? toast(next, "success", "Connection successful")
				: toast(next, "error", "Connection failed", error ?? ""),
	])
}

export const clickedToggle = (model: Model, id: ScrapeTargetId): Return => {
	const target = targetOf(model, id)
	if (target === undefined || model.prometheusCard.toggling.includes(id)) return { model }
	return {
		model: withCard(model, { toggling: [...model.prometheusCard.toggling, id] }),
		commands: [ToggleTarget({ id, enabled: !target.enabled })],
	}
}

export const completedToggle = (
	model: Model,
	context: PageContext,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { toggling: without(model.prometheusCard.toggling, id) })
	return failure === null
		? refreshTargets(settled, context)
		: toast(settled, "error", "Couldn't update scrape target", failure.message)
}

// FORM

const formDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { formDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotFormDialogMessage({ message }),
	),
})

const openForm = (model: Model, editingId: ScrapeTargetId | null, form: ScrapeForm): Return =>
	formDialogStep(
		withCard(model, {
			editingId,
			form,
			authSelect: Select.init("scrape-auth-type", {
				value: form.authType,
				selectedIndex: ["none", "bearer", "basic"].indexOf(form.authType),
			}),
		}),
		Dialog.open(model.prometheusCard.formDialog),
	)

export const clickedEdit = (model: Model, id: ScrapeTargetId): Return => {
	const target = targetOf(model, id)
	if (target === undefined) return { model }
	return openForm(model, id, {
		...emptyForm(),
		name: Field.init(target.name),
		serviceName: Field.init(target.service_name ?? ""),
		url: Field.init(target.url),
		interval: Field.init(String(target.scrape_interval_seconds)),
		authType: target.auth_type === "bearer" || target.auth_type === "basic" ? target.auth_type : "none",
	})
}

export const gotFormDialog = (model: Model, message: Dialog.Message): Return =>
	model.prometheusCard.isSaving
		? { model }
		: formDialogStep(model, Dialog.update(model.prometheusCard.formDialog, message))

export const gotFormField = (model: Model, field: FormFieldName, message: Field.Message): Return => {
	const step = Field.update(model.prometheusCard.form[field], message)
	return {
		model: withCard(model, { form: { ...model.prometheusCard.form, [field]: step.model } }),
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
			Message.GotFormFieldMessage({ field, message: inner }),
		),
	}
}

/** Picking an auth type clears every credential field. */
export const gotAuthSelect = (model: Model, message: Select.Message): Return => {
	const step = Select.update(model.prometheusCard.authSelect, message)
	const lifted = withCard(model, { authSelect: step.model })
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotAuthSelectMessage({ message: inner }),
	)
	if (step.outMessage === undefined) return { model: lifted, commands }
	const value = step.outMessage.value
	const authType = value === "bearer" || value === "basic" ? value : "none"
	return {
		model: withCard(lifted, {
			form: {
				...lifted.prometheusCard.form,
				authType,
				token: Field.init(),
				username: Field.init(),
				password: Field.init(),
			},
		}),
		commands,
	}
}

const decodeInterval = Schema.decodeUnknownOption(ScrapeIntervalSeconds)

/** `parsedInterval`: `Number.parseInt(value) || 15`, then the 5..300 integer check. */
export const parsedInterval = (form: ScrapeForm): number | null => {
	const parsed = Number.parseInt(form.interval.value, 10)
	return Option.getOrNull(decodeInterval(Number.isNaN(parsed) || parsed === 0 ? 15 : parsed))
}

export const isFormValid = (form: ScrapeForm): boolean =>
	form.name.value.trim().length > 0 && form.url.value.trim().length > 0 && parsedInterval(form) !== null

const credentialsOf = (form: ScrapeForm): string | null => {
	if (form.authType === "bearer")
		return form.token.value.trim() === "" ? null : JSON.stringify({ token: form.token.value.trim() })
	if (form.authType === "basic")
		return form.username.value.trim() === "" && form.password.value.trim() === ""
			? null
			: JSON.stringify({ username: form.username.value.trim(), password: form.password.value.trim() })
	return null
}

/** The connect flow asks for the URL first: a blank name falls back to the URL's host. */
const withDefaultName = (form: ScrapeForm): ScrapeForm =>
	form.name.value.trim() === "" && form.url.value.trim() !== ""
		? { ...form, name: Field.init(hostnameOf(form.url.value.trim())) }
		: form

export const submittedForm = (model: Model): Return => {
	const card = model.prometheusCard
	const form = withDefaultName(card.form)
	const interval = parsedInterval(form)
	if (card.isSaving || !isFormValid(form) || interval === null) return { model }
	const credentials = credentialsOf(form)
	const serviceName = form.serviceName.value.trim()
	return {
		model: withCard(model, { isSaving: true, form }),
		commands: [
			SaveTarget({
				editingId: card.editingId,
				payload: {
					name: form.name.value.trim(),
					scrape_interval_seconds: interval,
					service_name: serviceName === "" ? null : serviceName,
					url: form.url.value.trim(),
					auth_type: form.authType,
					auth_credentials: credentials ?? undefined,
				},
			}),
		],
	}
}

export const completedSave = (
	model: Model,
	context: PageContext,
	isEdit: boolean,
	id: ScrapeTargetId | null,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isSaving: false })
	if (failure !== null)
		return toast(
			settled,
			"error",
			isEdit ? "Couldn't update scrape target" : "Couldn't create scrape target",
			failure.message,
		)
	return chain(settled, [
		(next) => toast(next, "success", isEdit ? "Scrape target updated" : "Scrape target created"),
		(next) => refreshTargets(next, context),
		(next) => formDialogStep(next, Dialog.close(next.prometheusCard.formDialog)),
		// A new target becomes the one being edited, so the connect flow's later saves update it.
		(next) =>
			isEdit || id === null
				? { model: next }
				: clickedTarget(withCard(next, { editingId: id }), context, id),
		// Every save is probed, so the flow's status row answers without a Test button.
		(next) => (id === null ? { model: next } : clickedProbe(next, id)),
	])
}

// DELETE

const deleteDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { deleteDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotTargetDeleteDialogMessage({ message }),
	),
})

export const clickedDelete = (model: Model, id: ScrapeTargetId): Return =>
	deleteDialogStep(withCard(model, { deleteId: id }), Dialog.open(model.prometheusCard.deleteDialog))

export const gotDeleteDialog = (model: Model, message: Dialog.Message): Return =>
	model.prometheusCard.isDeleting
		? { model }
		: deleteDialogStep(model, Dialog.update(model.prometheusCard.deleteDialog, message))

/** The confirm button stays pending until the delete answers (`ConfirmDialog`'s promise). */
export const confirmedDelete = (model: Model): Return => {
	const id = model.prometheusCard.deleteId
	if (id === null || model.prometheusCard.isDeleting) return { model }
	return { model: withCard(model, { isDeleting: true }), commands: [DeleteTarget({ id })] }
}

export const completedDelete = (
	model: Model,
	context: PageContext,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isDeleting: false })
	if (failure !== null) return toast(settled, "error", "Couldn't delete scrape target", failure.message)
	return chain(settled, [
		(next) => toast(next, "success", "Scrape target deleted"),
		(next) => refreshTargets(next, context),
		(next) => ({
			model: next.prometheusCard.selectedId === id ? withCard(next, { selectedId: null }) : next,
		}),
		(next) =>
			deleteDialogStep(
				withCard(next, { deleteId: null }),
				Dialog.close(next.prometheusCard.deleteDialog),
			),
	])
}

// ROW MENU

export const gotTargetMenu = (model: Model, id: ScrapeTargetId, message: Menu.Message): Return => {
	const menuId = `scrape-target-menu-${id}`
	const step = Menu.update(model.prometheusCard.menus[menuId] ?? Menu.init(menuId), message)
	const next = withCard(model, { menus: { ...model.prometheusCard.menus, [menuId]: step.model } })
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotTargetMenuMessage({ id, message: inner }),
	)
	const picked = step.outMessage?._tag === "SelectedItem" ? step.outMessage.value : null
	const after =
		picked === "edit"
			? clickedEdit(next, id)
			: picked === "delete"
				? clickedDelete(next, id)
				: { model: next }
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}
