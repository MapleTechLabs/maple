import type {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageIncidentId,
	StatusPageIncidentKind,
} from "@maple/domain"
import { StatusPageIncidentImpact, StatusPageIncidentStatus } from "@maple/domain"
import { worstStatus } from "@maple/domain/status-page"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import type { LoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { componentStatus, isOpenIncident, STATUSES_OF_KIND } from "../shared/derive"
import { CreateIncident, FocusEditorElement, PostIncidentUpdate, PublishIncident } from "./command"
import {
	emptyIncidentForm,
	type IncidentTextField,
	incidentIssues,
	incidentPayload,
	updateFormFor,
} from "../shared/form"

import type { Model } from "./model"
import {
	chain,
	componentsOf,
	errorToast,
	incidentsOf,
	monitorsOf,
	readIncidents,
	readPage,
	type Return,
	toast,
} from "./reads"
import { focusPanel } from "./update-components"

/** The update form's message field: focused when Post update or Resolve opens it. */
export const UPDATE_BODY_ID = "status-page-update-body"

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
			? components.filter((component) => component.id === selected)
			: components.filter((component) => statusOf(component) !== "operational")
	const blank = emptyIncidentForm(kind)
	const form =
		kind === "maintenance" || affected.length === 0
			? { ...blank, componentIds: affected.map((component) => component.id) }
			: {
					...blank,
					componentIds: affected.map((component) => component.id),
					impact: IMPACT_OF_STATUS[worstStatus(affected.map(statusOf))],
				}
	return focusPanel({ ...model, panel: { _tag: "Compose" }, incidentForm: form, incidentFailure: null })
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
					? ids.filter((id) => id !== componentId)
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
				{ ...settled, panel: { _tag: "Incident", incidentId: incident.id }, updateForm: null },
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

/** Opens the incident in the panel, its update form closed. */
export const selectIncident = (model: Model, incidentId: StatusPageIncidentId): Return =>
	incidentsOf(model).some((incident) => incident.id === incidentId)
		? focusPanel({
				...model,
				panel: { _tag: "Incident", incidentId },
				updateForm: null,
				updateFailure: null,
			})
		: { model }

export const openUpdate = (model: Model, incidentId: StatusPageIncidentId, isResolving: boolean): Return => {
	const incident = incidentsOf(model).find((row) => row.id === incidentId)
	return incident === undefined || !isOpenIncident(incident)
		? { model }
		: {
				model: {
					...model,
					panel: { _tag: "Incident", incidentId },
					updateForm: updateFormFor(incident, isResolving),
					updateFailure: null,
				},
				commands: [FocusEditorElement({ id: UPDATE_BODY_ID })],
			}
}

export const changeUpdate = (model: Model, field: "status" | "body", value: string): Return => {
	const form = model.updateForm
	if (form === null) return { model }
	if (field === "body") return { model: { ...model, updateForm: { ...form, body: value } } }
	const allowed: ReadonlyArray<string> = STATUSES_OF_KIND[form.kind]
	return Option.match(decodeStatus(value), {
		onNone: () => ({ model }),
		onSome: (status) =>
			allowed.includes(status) ? { model: { ...model, updateForm: { ...form, status } } } : { model },
	})
}

export const submitUpdate = (model: Model): Return => {
	const form = model.updateForm
	return form === null || model.isPostingUpdate || form.body.trim() === ""
		? { model }
		: {
				model: { ...model, isPostingUpdate: true, updateFailure: null },
				commands: [
					PostIncidentUpdate({
						incidentId: form.incidentId,
						payload: { status: form.status, body: form.body.trim() },
					}),
				],
			}
}

export const postedUpdate = (
	model: Model,
	result: Result.Result<V2StatusPageIncident, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isPostingUpdate: false }
	return Result.match(result, {
		onSuccess: (incident): Return => ({
			...reread({ ...settled, updateForm: null }, context),
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
		onFailure: (updateFailure): Return => ({ model: { ...settled, updateFailure } }),
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
		publishingIncidentIds: model.publishingIncidentIds.filter((id) => id !== incidentId),
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
