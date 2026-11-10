import { Command } from "foldkit"
import * as Dialog from "@maple/views/ui/dialog"
import type { PageContext, PageReturn } from "../../contract"
import { editingRuleOf, initialization } from "./draft"
import type { RuleForm } from "./form"
import * as F from "./form-steps"
import { Message, type SignalKind } from "./message"
import type { Model } from "./model"
import { applyDefaultDestination, planMetrics, planPreviews } from "./plan"
import { isProtectedDefault } from "./derive"
import { draftTimingOf } from "./derive-rows"
import { missingCards, RULE_CARDS } from "./summary"
import { Option, String as Str, Array as Arr } from "effect"

export type Return = PageReturn<Model, Message>

/** The planned reads of a step, as a page return: the previews, and the metric picker's lists. */
const planned = (model: Model, context: PageContext): Return => {
	const step = planPreviews(model, context)
	const metrics = planMetrics(step.model)
	return { model: metrics.model, commands: [...step.commands, ...metrics.commands] }
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
	if (draft._tag === "Failed" || draft._tag === "Unreadable")
		return { model: { ...model, status: draft._tag } }
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
		isNotesOpen: Str.trim(form.notes).length > 0,
		isMessageTemplateOpen: form.notificationTitle.length > 0 || form.notificationBody.length > 0,
	}
	// A new rule opens every card; a saved one opens on its summaries, with any gap left open.
	const withCards: Model = {
		...ready,
		expandedCards:
			draft.editingRule === null ? RULE_CARDS : missingCards(form, null, isProtectedDefault(ready)),
	}
	const loaded = planned(applyDefaultDestination(withCards), context)
	if (!draft.isShowingTemplates) return loaded
	const opened = liftTemplates(loaded.model, Dialog.open(loaded.model.templates))
	return { model: opened.model, commands: [...(loaded.commands ?? []), ...(opened.commands ?? [])] }
}

/** An edit to the draft; the preview follows it (`useDeferredValue` over the form). */
/** Marks a control as left (by element id), so it shows its error from now on. */
export const touched = (model: Model, id: string): Model =>
	model.touchedFields.includes(id) ? model : { ...model, touchedFields: [...model.touchedFields, id] }

/** Opens every card with a save blocker; it stays open once fixed, so it never closes under the cursor. */
export const withMissingCardsOpen = (model: Model): Model =>
	model.form === null
		? model
		: {
				...model,
				expandedCards: Arr.union(
					model.expandedCards,
					missingCards(model.form, draftTimingOf(model, model.form), isProtectedDefault(model)),
				),
			}

export const editForm = (model: Model, context: PageContext, edit: (form: RuleForm) => RuleForm): Return =>
	model.form === null
		? { model }
		: planned(withMissingCardsOpen({ ...model, form: edit(model.form) }), context)

/** A list answered: the draft may now be known, and the default destination picked. */
export const followRows = (model: Model, context: PageContext): Return => {
	if (model.form === null) return initialize(model, context)
	// A newer build rewrote the open rule into something this one cannot read: saving the stale
	// form would write the old values back over it, so the editor stops as on open.
	if (
		model.editingRuleId !== null &&
		Option.exists(editingRuleOf(model, model.editingRuleId), Option.isNone)
	)
		return { model: { ...model, form: null, status: "Unreadable" } }
	return { model: applyDefaultDestination(model) }
}

/** The mode switch: the filters carry over, and a destination the editor chose leaves an anomaly rule. */
export const switchKindStep = (model: Model, context: PageContext, kind: SignalKind): Return => {
	if (model.form === null || isProtectedDefault(model)) return { model }
	const moved = F.switchKind(model.form, kind)
	// Anomaly paging is opt-in: a destination the editor chose, not the user, does not carry over.
	const auto = model.autoDestinationId
	const form =
		kind === "anomaly" && auto !== null
			? F.updateTierIds(
					F.updateTierIds(moved.form, "warning", F.removeId(auto)),
					"critical",
					F.removeId(auto),
				)
			: moved.form
	return editForm(
		{ ...model, kindNotice: moved.notice, autoDestinationId: kind === "anomaly" ? null : auto },
		context,
		() => form,
	)
}
