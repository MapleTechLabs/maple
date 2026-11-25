import { encodeJson, requestKey } from "@maple/views/data/request-key"
import type { ScrapeTargetId } from "@maple/domain/http"
import { ScrapeIntervalSeconds } from "@maple/domain/http"
import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import type { PageContext } from "../contract"
import {
	DeleteTarget,
	emptyForm,
	FetchChecks,
	type FormFieldName,
	hostnameOf,
	type PrometheusCardModel,
	PrometheusMessage,
	ProbeTarget,
	SaveTarget,
	type ScrapeForm,
	ToggleTarget,
} from "./prometheus"
import type { Model } from "./model"
import { HubRequest, type ProviderEnv, type ProviderReturn } from "./provider"

// The scrape-target card's state changes (Prometheus and WarpStream), as their module's update.

type Targets = ReadonlyArray<V2ScrapeTarget>
type Env = ProviderEnv<Targets>
type Return = ProviderReturn<PrometheusCardModel, PrometheusMessage>

const withCard = (model: PrometheusCardModel, card: Partial<PrometheusCardModel>): PrometheusCardModel => ({
	...model,
	...card,
})

/** Runs steps in order: the last step's model, every request and Command in order. */
const steps = (
	model: PrometheusCardModel,
	next: ReadonlyArray<(model: PrometheusCardModel) => Return>,
): Return =>
	Arr.reduce<(typeof next)[number], Return>(next, { model }, (acc, step) => {
		const result = step(acc.model)
		return {
			model: result.model,
			requests: [...(acc.requests ?? []), ...(result.requests ?? [])],
			commands: [...(acc.commands ?? []), ...(result.commands ?? [])],
		}
	})

const toast = (
	model: PrometheusCardModel,
	type: "success" | "error",
	title: string,
	description = "",
): Return => ({ model, requests: [HubRequest.toast(type, title, description)] })

const refreshTargets = (model: PrometheusCardModel): Return => ({
	model,
	requests: [HubRequest.readStatus("Supersede")],
})

const targetsIn = (slot: Keyed.Keyed<Targets, LoadFailure>): Targets =>
	Option.match(AsyncData.getData(slot.data), {
		onNone: () => [],
		onSome: (targets) => Arr.filter(targets, (target) => target.target_type === "prometheus"),
	})

/** The prometheus targets, as the list read answered them. */
export const prometheusTargets = (model: Model): Targets => targetsIn(model.statuses.scrapeTargets)

const targetOf = (env: Env, id: ScrapeTargetId) =>
	Option.getOrUndefined(Arr.findFirst(targetsIn(env.status), (target) => target.id === id))

const checksKey = (context: PageContext, id: ScrapeTargetId) =>
	requestKey(context.orgId, "scrapeTargets.listChecks", { id })

const requestChecks = (model: PrometheusCardModel, env: Env, mode: Keyed.RequestMode): Return => {
	const id = model.selectedId
	if (id === null) return { model }
	const key = checksKey(env.context, id)
	return Option.match(Keyed.request(model.checks, key, mode), {
		onNone: () => ({ model }),
		onSome: (checks) => ({ model: withCard(model, { checks }), commands: [FetchChecks({ key, id })] }),
	})
}

const clickedTarget = (model: PrometheusCardModel, env: Env, id: ScrapeTargetId): Return =>
	requestChecks(withCard(model, { selectedId: id }), env, "Load")

const without = (ids: ReadonlyArray<ScrapeTargetId>, id: ScrapeTargetId) =>
	Arr.filter(ids, (entry) => entry !== id)

const clickedProbe = (model: PrometheusCardModel, id: ScrapeTargetId): Return =>
	model.probing.includes(id)
		? { model }
		: { model: withCard(model, { probing: [...model.probing, id] }), commands: [ProbeTarget({ id })] }

/** `probe`: invalidated by its `reactivityKeys`, then refreshed again, then the verdict toast. */
const completedProbe = (
	model: PrometheusCardModel,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
	success: boolean,
	error: string | null,
): Return => {
	const outcome = failure === null ? { success, error } : { success: false, error: failure.message }
	const settled = withCard(model, {
		probing: without(model.probing, id),
		probes: { ...model.probes, [id]: outcome },
	})
	if (failure !== null) return toast(settled, "error", "Couldn't test connection", failure.message)
	return steps(settled, [
		refreshTargets,
		(next) =>
			success
				? toast(next, "success", "Connection successful")
				: toast(next, "error", "Connection failed", error ?? ""),
	])
}

const clickedToggle = (model: PrometheusCardModel, env: Env, id: ScrapeTargetId): Return => {
	const target = targetOf(env, id)
	if (target === undefined || model.toggling.includes(id)) return { model }
	return {
		model: withCard(model, { toggling: [...model.toggling, id] }),
		commands: [ToggleTarget({ id, enabled: !target.enabled })],
	}
}

const completedToggle = (
	model: PrometheusCardModel,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { toggling: without(model.toggling, id) })
	return failure === null
		? refreshTargets(settled)
		: toast(settled, "error", "Couldn't update scrape target", failure.message)
}

const formDialogStep = (model: PrometheusCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { formDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		PrometheusMessage.GotFormDialogMessage({ message }),
	),
})

const openForm = (model: PrometheusCardModel, editingId: ScrapeTargetId | null, form: ScrapeForm): Return =>
	formDialogStep(
		withCard(model, {
			editingId,
			form,
			authSelect: Select.init("scrape-auth-type", {
				value: form.authType,
				selectedIndex: ["none", "bearer", "basic"].indexOf(form.authType),
			}),
		}),
		Dialog.open(model.formDialog),
	)

const clickedEdit = (model: PrometheusCardModel, env: Env, id: ScrapeTargetId): Return => {
	const target = targetOf(env, id)
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

const gotFormField = (model: PrometheusCardModel, field: FormFieldName, message: Field.Message): Return => {
	const step = Field.update(model.form[field], message)
	return {
		model: withCard(model, { form: { ...model.form, [field]: step.model } }),
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			PrometheusMessage.GotFormFieldMessage({ field, message: inner }),
		),
	}
}

/** Picking an auth type clears every credential field. */
const gotAuthSelect = (model: PrometheusCardModel, message: Select.Message): Return => {
	const step = Select.update(model.authSelect, message)
	const lifted = withCard(model, { authSelect: step.model })
	const commands = Command.mapMessages(step.commands ?? [], (inner) =>
		PrometheusMessage.GotAuthSelectMessage({ message: inner }),
	)
	if (step.outMessage === undefined) return { model: lifted, commands }
	const value = step.outMessage.value
	const authType = value === "bearer" || value === "basic" ? value : "none"
	return {
		model: withCard(lifted, {
			form: {
				...lifted.form,
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

export const parsedInterval = (form: ScrapeForm): number | null => {
	const parsed = Number.parseInt(form.interval.value, 10)
	return Option.getOrNull(decodeInterval(Number.isNaN(parsed) || parsed === 0 ? 15 : parsed))
}

export const isFormValid = (form: ScrapeForm): boolean =>
	Str.trim(form.name.value).length > 0 &&
	Str.trim(form.url.value).length > 0 &&
	parsedInterval(form) !== null

const credentialsOf = (form: ScrapeForm): string | null => {
	if (form.authType === "bearer")
		return Str.trim(form.token.value) === "" ? null : encodeJson({ token: Str.trim(form.token.value) })
	if (form.authType === "basic")
		return Str.trim(form.username.value) === "" && Str.trim(form.password.value) === ""
			? null
			: encodeJson({ username: Str.trim(form.username.value), password: Str.trim(form.password.value) })
	return null
}

/** The connect flow asks for the URL first: a blank name falls back to the URL's host. */
const withDefaultName = (form: ScrapeForm): ScrapeForm =>
	Str.trim(form.name.value) === "" && Str.trim(form.url.value) !== ""
		? { ...form, name: Field.init(hostnameOf(Str.trim(form.url.value))) }
		: form

const submittedForm = (model: PrometheusCardModel): Return => {
	const form = withDefaultName(model.form)
	const interval = parsedInterval(form)
	if (model.isSaving || !isFormValid(form) || interval === null) return { model }
	const credentials = credentialsOf(form)
	const serviceName = Str.trim(form.serviceName.value)
	return {
		model: withCard(model, { isSaving: true, form }),
		commands: [
			SaveTarget({
				editingId: model.editingId,
				payload: {
					name: Str.trim(form.name.value),
					scrape_interval_seconds: interval,
					service_name: serviceName === "" ? null : serviceName,
					url: Str.trim(form.url.value),
					auth_type: form.authType,
					auth_credentials: credentials ?? undefined,
				},
			}),
		],
	}
}

const completedSave = (
	model: PrometheusCardModel,
	env: Env,
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
	return steps(settled, [
		(next) => toast(next, "success", isEdit ? "Scrape target updated" : "Scrape target created"),
		refreshTargets,
		(next) => formDialogStep(next, Dialog.close(next.formDialog)),
		// A new target becomes the one being edited, so the connect flow's later saves update it.
		(next) =>
			isEdit || id === null
				? { model: next }
				: clickedTarget(withCard(next, { editingId: id }), env, id),
		// Every save is probed, so the flow's status row answers without a Test button.
		(next) => (id === null ? { model: next } : clickedProbe(next, id)),
	])
}

const deleteDialogStep = (model: PrometheusCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { deleteDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		PrometheusMessage.GotTargetDeleteDialogMessage({ message }),
	),
})

const clickedDelete = (model: PrometheusCardModel, id: ScrapeTargetId): Return =>
	deleteDialogStep(withCard(model, { deleteId: id }), Dialog.open(model.deleteDialog))

/** The confirm button stays pending until the delete answers. */
const confirmedDelete = (model: PrometheusCardModel): Return => {
	const id = model.deleteId
	if (id === null || model.isDeleting) return { model }
	return { model: withCard(model, { isDeleting: true }), commands: [DeleteTarget({ id })] }
}

const completedDelete = (
	model: PrometheusCardModel,
	id: ScrapeTargetId,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isDeleting: false })
	if (failure !== null) return toast(settled, "error", "Couldn't delete scrape target", failure.message)
	return steps(settled, [
		(next) => toast(next, "success", "Scrape target deleted"),
		refreshTargets,
		(next) => ({ model: next.selectedId === id ? withCard(next, { selectedId: null }) : next }),
		(next) => deleteDialogStep(withCard(next, { deleteId: null }), Dialog.close(next.deleteDialog)),
	])
}

const gotTargetMenu = (
	model: PrometheusCardModel,
	env: Env,
	id: ScrapeTargetId,
	message: Menu.Message,
): Return => {
	const menuId = `scrape-target-menu-${id}`
	const step = Menu.update(model.menus[menuId] ?? Menu.init(menuId), message)
	const next = withCard(model, { menus: { ...model.menus, [menuId]: step.model } })
	const commands = Command.mapMessages(step.commands ?? [], (inner) =>
		PrometheusMessage.GotTargetMenuMessage({ id, message: inner }),
	)
	const picked = step.outMessage?._tag === "SelectedItem" ? step.outMessage.value : null
	const after =
		picked === "edit"
			? clickedEdit(next, env, id)
			: picked === "delete"
				? clickedDelete(next, id)
				: { model: next }
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}

export const update = (model: PrometheusCardModel, message: PrometheusMessage, env: Env): Return =>
	PrometheusMessage.match<Return>(message, {
		ClickedTarget: ({ id }) => clickedTarget(model, env, id),
		CompletedFetchChecks: ({ key, result }) => ({
			model: withCard(model, { checks: Keyed.accept(model.checks, key, result) }),
		}),
		TickedTargetsRefresh: () => ({ model, requests: [HubRequest.readStatus("Refresh")] }),
		TickedChecksRefresh: () => requestChecks(model, env, "Refresh"),
		ClickedProbe: ({ id }) => clickedProbe(model, id),
		CompletedProbe: ({ id, failure, success, error }) =>
			completedProbe(model, id, failure, success, error),
		ClickedToggleTarget: ({ id }) => clickedToggle(model, env, id),
		CompletedToggle: ({ id, failure }) => completedToggle(model, id, failure),
		ClickedEditTarget: ({ id }) => clickedEdit(model, env, id),
		ClickedDeleteTarget: ({ id }) => clickedDelete(model, id),
		GotTargetMenuMessage: ({ id, message: child }) => gotTargetMenu(model, env, id, child),
		GotFormDialogMessage: ({ message: child }) =>
			model.isSaving ? { model } : formDialogStep(model, Dialog.update(model.formDialog, child)),
		GotFormFieldMessage: ({ field, message: child }) => gotFormField(model, field, child),
		GotAuthSelectMessage: ({ message: child }) => gotAuthSelect(model, child),
		SubmittedTargetForm: () => submittedForm(model),
		CompletedSave: ({ isEdit, id, failure }) => completedSave(model, env, isEdit, id, failure),
		GotTargetDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : deleteDialogStep(model, Dialog.update(model.deleteDialog, child)),
		ConfirmedTargetDelete: () => confirmedDelete(model),
		CompletedTargetDelete: ({ id, failure }) => completedDelete(model, id, failure),
	})
