import { Command } from "foldkit"
import * as Dialog from "../../../ui/dialog"
import type { PageContext, PageReturn } from "../../contract"
import { initialization } from "./draft"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { applyDefaultDestination, planPreviews } from "./plan"

export type Return = PageReturn<Model, Message>

/** The planned reads of a step, as a page return. */
const planned = (model: Model, context: PageContext): Return => {
	const step = planPreviews(model, context)
	return { model: step.model, commands: step.commands }
}

export const liftTemplates = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, templates: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotTemplatesMessage({ message })),
})

/** The draft, once its inputs answered: the form surface mounts with it (`ready`). */
export const initialize = (model: Model, context: PageContext): Return => {
	if (model.form !== null || model.draftId === null) return { model }
	const draft = initialization(model, model.draftId)
	if (draft._tag === "Loading") return { model }
	if (draft._tag === "Failed") return { model: { ...model, status: "Failed" } }
	const form = draft.form
	const ready: Model = {
		...model,
		status: "Ready",
		draftKey: draft.key,
		form,
		savedForm: draft.editingRule === null ? null : form,
		editingRuleId: draft.editingRule?.id ?? null,
		mountedForm: form,
		notices: draft.notices,
		isDefaultDestinationApplied: draft.editingRule !== null,
		isNotesOpen: form.notes.trim().length > 0,
		isMessageTemplateOpen: form.notificationTitle.length > 0 || form.notificationBody.length > 0,
	}
	const loaded = planned(applyDefaultDestination(ready), context)
	if (!draft.isShowingTemplates) return loaded
	const opened = liftTemplates(loaded.model, Dialog.open(loaded.model.templates))
	return { model: opened.model, commands: [...(loaded.commands ?? []), ...(opened.commands ?? [])] }
}

/** An edit to the draft; the preview follows it (`useDeferredValue` over the form). */
export const editForm = (model: Model, context: PageContext, edit: (form: RuleForm) => RuleForm): Return =>
	model.form === null ? { model } : planned({ ...model, form: edit(model.form) }, context)

/** A list answered: the draft may now be known, and the default destination picked. */
export const followRows = (model: Model, context: PageContext): Return =>
	model.form === null ? initialize(model, context) : { model: applyDefaultDestination(model) }
