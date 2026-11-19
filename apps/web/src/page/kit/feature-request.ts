import {
	FEATURE_REQUEST_NOTE_MAX_LENGTH,
	FEATURE_REQUEST_SUBJECT_MAX_LENGTH,
	FeatureRequestArea,
	FeatureRequestPayload,
} from "@maple/domain/http"
import { Effect, Result, Schema, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { failureMessage, LoadFailure, settleTo } from "@maple/views/data/load-failure"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { MapleInternalApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"

// Asking Maple to support something it does not yet: a cost provider, an integration. A page keeps
// this Model, routes its Messages through `update`, places `fields` in its own dialog or panel, and
// hears `Sent` once the request is stored. The area says where it was asked.

export const Model = Schema.Struct({
	area: FeatureRequestArea,
	/** What they ask for ("Hetzner"). */
	subject: Field.Model,
	/** Why they want it, optional. */
	note: Schema.String,
	isSending: Schema.Boolean,
	/** Why the last send failed, or why it was not sent, until the subject changes or it is sent again. */
	error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

/** A blank request in `area`, or one whose subject is already typed (a search that found nothing). */
export const init = (area: FeatureRequestArea, subject = ""): Model => ({
	area,
	subject: Field.init(Str.trim(subject)),
	note: "",
	isSending: false,
	error: null,
})

export const Message = defineMessageUnion({
	GotSubjectMessage: { message: Field.Message },
	ChangedNote: { value: Schema.String },
	Submitted: {},
	CompletedSend: { result: Schema.Result(Schema.Void, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	/** The request is stored: the page closes what it showed and thanks them. */
	Sent: { area: FeatureRequestArea, subject: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const SendFeatureRequest = Command.define("SendFeatureRequest", {
	args: { area: FeatureRequestArea, subject: Schema.String, note: Schema.String },
	messages: [Message.CompletedSend],
	execute: ({ area, subject, note }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.featureRequests.create({
				payload: new FeatureRequestPayload(note === "" ? { area, subject } : { area, subject, note }),
			}),
		).pipe(
			Effect.asVoid,
			settleTo((result) => Message.CompletedSend({ result })),
		),
})

/** Whether Submit would send: a subject is typed and nothing is in flight. */
export const canSubmit = (model: Model): boolean => !model.isSending && Str.trim(model.subject.value) !== ""

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotSubjectMessage: ({ message: inner }) =>
			model.isSending
				? { model }
				: {
						model: {
							...model,
							subject: Field.update(model.subject, inner).model,
							error: inner._tag === "ChangedValue" ? null : model.error,
						},
					},
		ChangedNote: ({ value }) => (model.isSending ? { model } : { model: { ...model, note: value } }),
		Submitted: () => {
			const subject = Str.trim(model.subject.value)
			const note = Str.trim(model.note)
			if (!canSubmit(model)) return { model }
			// The request refuses longer text before it is sent, which would leave it unanswered.
			if (subject.length > FEATURE_REQUEST_SUBJECT_MAX_LENGTH) {
				return { model: { ...model, error: "Use a shorter name." } }
			}
			if (note.length > FEATURE_REQUEST_NOTE_MAX_LENGTH) {
				return {
					model: {
						...model,
						error: `Keep the note under ${FEATURE_REQUEST_NOTE_MAX_LENGTH} characters.`,
					},
				}
			}
			return {
				model: { ...model, isSending: true, error: null },
				commands: [SendFeatureRequest({ area: model.area, subject, note })],
			}
		},
		CompletedSend: ({ result }) =>
			Result.match(result, {
				onFailure: (failure): Return => ({
					model: { ...model, isSending: false, error: failureMessage(failure) },
				}),
				onSuccess: (): Return => ({
					model: init(model.area),
					outMessage: OutMessage.Sent({ area: model.area, subject: Str.trim(model.subject.value) }),
				}),
			}),
	})

/** What the form says, per place it is asked from. */
export type Copy = Readonly<{
	subjectLabel: string
	subjectPlaceholder: string
	noteLabel: string
	noteHint: string
}>

/** The form's fields, for the page's own dialog or panel; `idPrefix` keeps two forms apart. */
export const fields = <P>(
	h: HtmlBuilder<P>,
	model: Model,
	options: Readonly<{ idPrefix: string; copy: Copy; toParent: (message: Message) => P }>,
): Html => {
	const { idPrefix, copy, toParent } = options
	const subjectIds: FieldIds = {
		control: `${idPrefix}-subject`,
		label: `${idPrefix}-subject-label`,
		error: `${idPrefix}-subject-error`,
		description: `${idPrefix}-subject-description`,
	}
	const noteDescriptionId = `${idPrefix}-note-description`
	const noteIds: FieldIds = {
		control: `${idPrefix}-note`,
		label: `${idPrefix}-note-label`,
		error: `${idPrefix}-note-error`,
		description: noteDescriptionId,
	}
	const subjectState = Field.stateOf(model.subject, model.error !== null)
	const noteState = Field.stateOf(Field.init(model.note), false)
	return vstack(h, { gap: "4" }, [
		field(h, { state: subjectState }, [
			fieldLabel(h, { ids: subjectIds, state: subjectState }, copy.subjectLabel),
			input(h, {
				ids: subjectIds,
				state: subjectState,
				attributes: [
					h.Placeholder(copy.subjectPlaceholder),
					h.Attribute("autocomplete", "off"),
					h.Attribute("maxlength", String(FEATURE_REQUEST_SUBJECT_MAX_LENGTH)),
					...(model.isSending ? [h.Disabled(true)] : []),
					...Field.controlAttributes(h, model.subject, (message) =>
						toParent(Message.GotSubjectMessage({ message })),
					),
				],
			}),
			...(model.error === null
				? []
				: [
						fieldError(
							h,
							{ ids: subjectIds, state: subjectState, attributes: [h.Role("alert")] },
							[model.error],
						),
					]),
		]),
		field(h, { state: noteState }, [
			fieldLabel(h, { ids: noteIds, state: noteState }, copy.noteLabel),
			textarea(h, {
				id: noteIds.control,
				isDisabled: model.isSending,
				defaultValue: model.note,
				attributes: [
					h.AriaLabelledBy(noteIds.label),
					h.AriaDescribedBy(noteDescriptionId),
					h.Rows(3),
					h.OnInput((value) => toParent(Message.ChangedNote({ value }))),
				],
			}),
			fieldDescription(h, { ids: noteIds, state: noteState }, [copy.noteHint]),
		]),
	])
}
