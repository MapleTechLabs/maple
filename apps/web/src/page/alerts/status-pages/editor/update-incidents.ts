import type { StatusPageComponentId, StatusPageIncidentId, StatusPageIncidentKind } from "@maple/domain"
import { StatusPageIncidentImpact, StatusPageIncidentStatus } from "@maple/domain"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import type { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import type { PageContext } from "../../../contract"
import { isOpenIncident, STATUSES_OF_KIND } from "../../shared/status-page-derive"
import { CreateIncident, PostIncidentUpdate, PublishIncident } from "./command"
import {
	emptyIncidentForm,
	type IncidentTextField,
	incidentIssues,
	incidentPayload,
	updateFormFor,
} from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	errorToast,
	incidentsOf,
	liftDialog,
	readIncidents,
	readPage,
	type Return,
	toast,
} from "./reads"

// The Incidents tab: the composer, posting an update or resolving, publishing a draft.

const decodeImpact = Schema.decodeUnknownOption(StatusPageIncidentImpact)
const decodeStatus = Schema.decodeUnknownOption(StatusPageIncidentStatus)

export const incidentDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, incidentDialog) => ({ ...next, incidentDialog }),
		(message) => Message.GotIncidentDialogMessage({ message }),
	)

export const updateDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, updateDialog) => ({ ...next, updateDialog }),
		(message) => Message.GotUpdateDialogMessage({ message }),
	)

/** Incidents and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readIncidents(context, "Supersede"), readPage(context, "Supersede"))

export const openComposer = (model: Model, kind: StatusPageIncidentKind): Return =>
	incidentDialog(
		{ ...model, incidentForm: emptyIncidentForm(kind), incidentFailure: null },
		Dialog.open(model.incidentDialog),
	)

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
			const closed = incidentDialog(settled, Dialog.close(settled.incidentDialog))
			const refreshed = reread(closed.model, context)
			const noun = incident.kind === "incident" ? "Incident" : "Maintenance"
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
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

export const openUpdate = (model: Model, incidentId: StatusPageIncidentId, isResolving: boolean): Return => {
	const incident = incidentsOf(model).find((row) => row.id === incidentId)
	return incident === undefined || !isOpenIncident(incident)
		? { model }
		: updateDialog(
				{ ...model, updateForm: updateFormFor(incident, isResolving), updateFailure: null },
				Dialog.open(model.updateDialog),
			)
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
		onSuccess: (incident): Return => {
			const closed = updateDialog(settled, Dialog.close(settled.updateDialog))
			const refreshed = reread(closed.model, context)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast(
					"success",
					isOpenIncident(incident)
						? "Update posted"
						: incident.kind === "incident"
							? "Incident resolved"
							: "Maintenance completed",
					incident.title,
				),
			}
		},
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
