import type {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageIncidentId,
	StatusPageIncidentKind,
} from "@maple/domain"
import { StatusPageIncidentImpact, StatusPageIncidentStatus } from "@maple/domain"
import { worstStatus } from "@maple/domain/status-page"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { Option, Result, Schema, Array as Arr, String as Str } from "effect"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { componentStatus, isOpenIncident, STATUSES_OF_KIND } from "../shared/derive"
import * as Dialog from "@maple/views/ui/dialog"
import {
	CreateIncident,
	DeleteIncident,
	FocusEditorElement,
	PostIncidentUpdate,
	PublishIncident,
	SaveIncident,
} from "./command"
import {
	emptyIncidentForm,
	type IncidentEditField,
	incidentEditFormOf,
	incidentEditPayload,
	type IncidentTextField,
	incidentIssues,
	incidentPayload,
	type UpdateForm,
	updateFormFor,
} from "../shared/form"
import { Message } from "./message"
import type { Model, UpdateFormState } from "./model"
import {
	chain,
	componentsOf,
	errorToast,
	incidentsOf,
	liftDialog,
	monitorsOf,
	readIncidents,
	readPage,
	type Return,
	toast,
} from "./reads"
import { focusPanel } from "./update-components"

/** The update form's message field: focused when Post update or Resolve opens it. */
export const UPDATE_BODY_ID = "status-page-update-body"

/** The details form's title field: focused when Edit opens it. */
export const INCIDENT_EDIT_TITLE_ID = "status-page-incident-edit-title"

// Incidents in the side panel: the composer, an update or a resolve, publishing a draft.

const decodeImpact = Schema.decodeUnknownOption(StatusPageIncidentImpact)
const decodeStatus = Schema.decodeUnknownOption(StatusPageIncidentStatus)

/** Incidents and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readIncidents(context, "Supersede"), readPage(context, "Supersede"))

const IMPACT_OF_STATUS = {
	operational: "minor",
	maintenance: "minor",
	degraded: "minor",
	partial_outage: "major",
	major_outage: "critical",
} as const satisfies Record<StatusPageComponentStatus, StatusPageIncidentImpact>

/**
 * The composer in the side panel, prefilled: the selected component, or else every component
 * visitors already see as not operational, with the impact their worst status suggests.
 */
export const openComposer = (model: Model, kind: StatusPageIncidentKind): Return => {
	const components = componentsOf(model)
	const statusOf = (component: (typeof components)[number]) =>
		componentStatus(component, monitorsOf(model), incidentsOf(model))
	const selected = model.panel?._tag === "Component" ? model.panel.componentId : null
	const affected =
		selected !== null
			? Arr.filter(components, (component) => component.id === selected)
			: Arr.filter(components, (component) => statusOf(component) !== "operational")
	const blank = emptyIncidentForm(kind)
	const form =
		kind === "maintenance" || affected.length === 0
			? { ...blank, componentIds: Arr.map(affected, (component) => component.id) }
			: {
					...blank,
					componentIds: Arr.map(affected, (component) => component.id),
					impact: IMPACT_OF_STATUS[worstStatus(Arr.map(affected, statusOf))],
				}
	return focusPanel({
		...model,
		panel: { _tag: "Compose" },
		incidentForm: form,
		incidentFailure: null,
		incidentEdit: null,
		incidentEditFailure: null,
	})
}

/** Switching Incident and Maintenance keeps what was typed; only kind-specific defaults reset. */
export const changeIncidentKind = (model: Model, kind: StatusPageIncidentKind): Return => {
	const blank = emptyIncidentForm(kind)
	return {
		model: {
			...model,
			incidentForm: { ...model.incidentForm, kind, status: blank.status, impact: blank.impact },
		},
	}
}

/** Impact and status arrive as select values; anything else is not one of theirs and is dropped. */
export const changeIncident = (model: Model, field: IncidentTextField, value: string): Return => {
	const form = model.incidentForm
	switch (field) {
		case "impact":
			return Option.match(decodeImpact(value), {
				onNone: () => ({ model }),
				onSome: (impact) => ({ model: { ...model, incidentForm: { ...form, impact } } }),
			})
		case "status":
			return Option.match(decodeStatus(value), {
				onNone: () => ({ model }),
				onSome: (status) => ({ model: { ...model, incidentForm: { ...form, status } } }),
			})
		default:
			return { model: { ...model, incidentForm: { ...form, [field]: value } } }
	}
}

export const toggleIncidentComponent = (model: Model, componentId: StatusPageComponentId): Return => {
	const ids = model.incidentForm.componentIds
	return {
		model: {
			...model,
			incidentForm: {
				...model.incidentForm,
				componentIds: ids.includes(componentId)
					? Arr.filter(ids, (id) => id !== componentId)
					: [...ids, componentId],
			},
		},
	}
}

export const submitIncident = (model: Model, context: PageContext): Return =>
	model.pageId === null ||
	model.isCreatingIncident ||
	incidentIssues(model.incidentForm, context.timeZone).length > 0
		? { model }
		: {
				model: { ...model, isCreatingIncident: true, incidentFailure: null },
				commands: [
					CreateIncident({
						payload: incidentPayload(model.incidentForm, model.pageId, context.timeZone),
					}),
				],
			}

export const createdIncident = (
	model: Model,
	result: Result.Result<V2StatusPageIncident, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isCreatingIncident: false }
	return Result.match(result, {
		onSuccess: (incident): Return => {
			const noun = incident.kind === "incident" ? "Incident" : "Maintenance"
			const refreshed = reread(
				{ ...settled, panel: { _tag: "Incident", incidentId: incident.id }, updateForm: CLOSED },
				context,
			)
			return {
				...refreshed,
				outMessage: toast(
					"success",
					incident.published ? `${noun} published` : `${noun} saved as a draft`,
					incident.title,
				),
			}
		},
		onFailure: (incidentFailure): Return => ({ model: { ...settled, incidentFailure } }),
	})
}

/** Opens the incident in the panel, its update and details forms closed. */
export const selectIncident = (model: Model, incidentId: StatusPageIncidentId): Return =>
	Arr.some(incidentsOf(model), (incident) => incident.id === incidentId)
		? focusPanel({
				...model,
				panel: { _tag: "Incident", incidentId },
				updateForm: CLOSED,
				incidentEdit: null,
				incidentEditFailure: null,
			})
		: { model }

export const openUpdate = (model: Model, incidentId: StatusPageIncidentId, isResolving: boolean): Return => {
	const incident = Option.getOrUndefined(Arr.findFirst(incidentsOf(model), (row) => row.id === incidentId))
	return incident === undefined || !isOpenIncident(incident)
		? { model }
		: {
				model: {
					...model,
					panel: { _tag: "Incident", incidentId },
					updateForm: { _tag: "Editing", form: updateFormFor(incident, isResolving) },
					incidentEdit: model.isSavingIncident ? model.incidentEdit : null,
				},
				commands: [FocusEditorElement({ id: UPDATE_BODY_ID })],
			}
}

const CLOSED: UpdateFormState = { _tag: "Closed" }

/** Edits apply while the form is open; a post in flight holds what it sends. */
export const changeUpdate = (model: Model, field: "status" | "body", value: string): Return => {
	const state = model.updateForm
	if (state._tag === "Closed" || state._tag === "Posting") return { model }
	const withForm = (form: UpdateForm): Return => ({ model: { ...model, updateForm: { ...state, form } } })
	if (field === "body") return withForm({ ...state.form, body: value })
	const allowed: ReadonlyArray<string> = STATUSES_OF_KIND[state.form.kind]
	return Option.match(decodeStatus(value), {
		onNone: () => ({ model }),
		onSome: (status) => (allowed.includes(status) ? withForm({ ...state.form, status }) : { model }),
	})
}

export const cancelUpdate = (model: Model): Return =>
	model.updateForm._tag === "Posting" ? { model } : { model: { ...model, updateForm: CLOSED } }

export const submitUpdate = (model: Model): Return => {
	const state = model.updateForm
	return state._tag === "Closed" || state._tag === "Posting" || Str.trim(state.form.body) === ""
		? { model }
		: {
				model: {
					...model,
					updateForm: { _tag: "Posting", form: state.form, generation: model.nextUpdatePost },
					nextUpdatePost: model.nextUpdatePost + 1,
				},
				commands: [
					PostIncidentUpdate({
						incidentId: state.form.incidentId,
						generation: model.nextUpdatePost,
						payload: { status: state.form.status, body: Str.trim(state.form.body) },
					}),
				],
			}
}

/** A post's result: the form settles only if it still shows that post; any success rereads. */
export const postedUpdate = (
	model: Model,
	generation: number,
	result: Result.Result<V2StatusPageIncident, LoadFailure>,
	context: PageContext,
): Return => {
	const state = model.updateForm
	const isShown = state._tag === "Posting" && state.generation === generation
	return Result.match(result, {
		onSuccess: (incident): Return => ({
			...reread(isShown ? { ...model, updateForm: CLOSED } : model, context),
			outMessage: toast(
				"success",
				isOpenIncident(incident)
					? "Update posted"
					: incident.kind === "incident"
						? "Incident resolved"
						: "Maintenance completed",
				incident.title,
			),
		}),
		onFailure: (failure): Return =>
			state._tag === "Posting" && isShown
				? { model: { ...model, updateForm: { _tag: "Failed", form: state.form, failure } } }
				: { model, outMessage: toast("error", "Couldn't post the update", failure.message) },
	})
}

export const publishIncident = (model: Model, incidentId: StatusPageIncidentId): Return =>
	model.publishingIncidentIds.includes(incidentId)
		? { model }
		: {
				model: { ...model, publishingIncidentIds: [...model.publishingIncidentIds, incidentId] },
				commands: [PublishIncident({ incidentId })],
			}

export const publishedIncident = (
	model: Model,
	incidentId: StatusPageIncidentId,
	result: Result.Result<V2StatusPageIncident, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = {
		...model,
		publishingIncidentIds: Arr.filter(model.publishingIncidentIds, (id) => id !== incidentId),
	}
	return Result.match(result, {
		onSuccess: (incident): Return => ({
			...reread(settled, context),
			outMessage: toast("success", "Draft published", incident.title),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't publish the draft", failure),
		}),
	})
}

// DETAILS

const nounOf = (kind: StatusPageIncidentKind): string => (kind === "incident" ? "Incident" : "Maintenance")

/** The title, impact and components as saved, open for editing; the update form gives way. */
export const openIncidentEdit = (model: Model, incidentId: StatusPageIncidentId): Return =>
	model.updateForm._tag === "Posting" || model.isSavingIncident
		? { model }
		: Option.match(
				Arr.findFirst(incidentsOf(model), (row) => row.id === incidentId),
				{
					onNone: (): Return => ({ model }),
					onSome: (incident): Return => ({
						model: {
							...model,
							panel: { _tag: "Incident", incidentId },
							updateForm: CLOSED,
							incidentEdit: incidentEditFormOf(incident),
							incidentEditFailure: null,
						},
						commands: [FocusEditorElement({ id: INCIDENT_EDIT_TITLE_ID })],
					}),
				},
			)

/** Edits apply until the save is sent; impact arrives as a select value. */
export const changeIncidentEdit = (model: Model, field: IncidentEditField, value: string): Return => {
	const form = model.incidentEdit
	if (form === null || model.isSavingIncident) return { model }
	return field === "title"
		? { model: { ...model, incidentEdit: { ...form, title: value } } }
		: Option.match(decodeImpact(value), {
				onNone: () => ({ model }),
				onSome: (impact) => ({ model: { ...model, incidentEdit: { ...form, impact } } }),
			})
}

export const toggleIncidentEditComponent = (model: Model, componentId: StatusPageComponentId): Return => {
	const form = model.incidentEdit
	return form === null || model.isSavingIncident
		? { model }
		: {
				model: {
					...model,
					incidentEdit: {
						...form,
						componentIds: form.componentIds.includes(componentId)
							? Arr.filter(form.componentIds, (id) => id !== componentId)
							: [...form.componentIds, componentId],
					},
				},
			}
}

export const cancelIncidentEdit = (model: Model): Return =>
	model.isSavingIncident
		? { model }
		: { model: { ...model, incidentEdit: null, incidentEditFailure: null } }

export const submitIncidentEdit = (model: Model): Return => {
	const form = model.incidentEdit
	return form === null || model.isSavingIncident || Str.trim(form.title) === ""
		? { model }
		: {
				model: { ...model, isSavingIncident: true, incidentEditFailure: null },
				commands: [SaveIncident({ incidentId: form.incidentId, payload: incidentEditPayload(form) })],
			}
}

/** A saved edit closes the form; a refused one keeps it open with the reason. */
export const savedIncident = (
	model: Model,
	result: Result.Result<V2StatusPageIncident, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isSavingIncident: false }
	return Result.match(result, {
		onSuccess: (incident): Return => ({
			...reread({ ...settled, incidentEdit: null }, context),
			outMessage: toast("success", `${nounOf(incident.kind)} updated`, incident.title),
		}),
		onFailure: (incidentEditFailure): Return =>
			settled.incidentEdit === null
				? { model: settled, outMessage: errorToast("Couldn't save the changes", incidentEditFailure) }
				: { model: { ...settled, incidentEditFailure } },
	})
}

// DELETE

export const deleteIncidentDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const lifted = liftDialog(
		model,
		step,
		(next, deleteIncidentDialog) => ({ ...next, deleteIncidentDialog }),
		(message) => Message.GotDeleteIncidentDialogMessage({ message }),
	)
	return step.outMessage?._tag === "Closed"
		? { ...lifted, model: { ...lifted.model, confirmDeleteIncidentId: null } }
		: lifted
}

export const askDeleteIncident = (model: Model, incidentId: StatusPageIncidentId): Return =>
	Arr.some(incidentsOf(model), (incident) => incident.id === incidentId)
		? deleteIncidentDialog(
				{ ...model, confirmDeleteIncidentId: incidentId },
				Dialog.open(model.deleteIncidentDialog),
			)
		: { model }

export const confirmDeleteIncident = (model: Model): Return => {
	const incidentId = model.confirmDeleteIncidentId
	return incidentId === null || model.isDeletingIncident
		? { model }
		: { model: { ...model, isDeletingIncident: true }, commands: [DeleteIncident({ incidentId })] }
}

/** A deleted incident leaves the page: its panel closes and the list is read again. */
export const deletedIncident = (
	model: Model,
	result: Result.Result<void, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isDeletingIncident: false }
	return Result.match(result, {
		onSuccess: (): Return => {
			const removedId = model.confirmDeleteIncidentId
			const removed = Arr.findFirst(incidentsOf(model), (row) => row.id === removedId)
			const closed = deleteIncidentDialog(settled, Dialog.close(settled.deleteIncidentDialog))
			const isShown =
				closed.model.panel?._tag === "Incident" && closed.model.panel.incidentId === removedId
			const refreshed = reread(
				isShown
					? { ...closed.model, panel: null, updateForm: CLOSED, incidentEdit: null }
					: closed.model,
				context,
			)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast(
					"success",
					`${Option.match(removed, { onNone: () => "Incident", onSome: (row) => nounOf(row.kind) })} deleted`,
					Option.match(removed, { onNone: () => "", onSome: (row) => row.title }),
				),
			}
		},
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't delete it", failure),
		}),
	})
}
