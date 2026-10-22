import { pickDefaultDestination } from "@maple/web-data/alerts/form-utils"
import { buildRuleStatesByRuleId, rowToAlertRuleDocument } from "@maple/web-data/collections/alerts"
import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import type { PageContext } from "../../contract"
import { AUTOCOMPLETE_LOOKUPS } from "../../kit/autocomplete-lookups"
import { previewPayload } from "../shared/preview"
import { destinationsOf } from "./derive-rows"
import { FetchEditorAutocomplete, FetchEditorPreview, FetchTraceFacets } from "./command"
import { previewIdentityKey } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"

// The editor's reads, planned from the Model: the autocomplete provider's lookups over 24h, the
// draft's preview and the saved rule's replay over the preview window.

type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export type Planned = Readonly<{ model: Model; commands: Commands }>

const none = (model: Model): Planned => ({ model, commands: [] })
const then = (step: Planned, next: (model: Model) => Planned): Planned => {
	const after = next(step.model)
	return { model: after.model, commands: [...step.commands, ...after.commands] }
}

/** `AutocompleteValuesProvider` (not lazy here): every lookup once the 24h window is known. */
export const planAutocomplete = (model: Model, context: PageContext): Planned => {
	const window = model.autocompleteWindow
	if (window === null) return none(model)
	const facetsKey = requestKey(context.orgId, "autocomplete.tracesFacets", window)
	const facets: Planned = Option.match(Keyed.request(model.traceFacets, facetsKey, "Load"), {
		onNone: () => none(model),
		onSome: (traceFacets) => ({
			model: { ...model, traceFacets },
			commands: [FetchTraceFacets({ key: facetsKey, window })],
		}),
	})
	return AUTOCOMPLETE_LOOKUPS.filter((lookup) => lookup !== "tracesFacets").reduce<Planned>(
		(step, lookup) => {
			const key = requestKey(context.orgId, `autocomplete.${lookup}`, window)
			return Option.match(Keyed.request(step.model.autocomplete[lookup] ?? Keyed.idle(), key, "Load"), {
				onNone: () => step,
				onSome: (slot) => ({
					model: { ...step.model, autocomplete: { ...step.model.autocomplete, [lookup]: slot } },
					commands: [...step.commands, FetchEditorAutocomplete({ key, lookup, window })],
				}),
			})
		},
		facets,
	)
}

/** Whether the saved rule evaluates differently from the draft (`evaluationChanged`). */
export const isEvaluationChanged = (model: Pick<Model, "savedForm" | "form">): boolean =>
	model.savedForm !== null &&
	model.form !== null &&
	previewIdentityKey(model.savedForm) !== previewIdentityKey(model.form)

/** `useAlertRulePreview` for the draft and, once it evaluates differently, the saved rule. */
export const planPreviews = (model: Model, context: PageContext): Planned => {
	const window = model.previewWindow
	if (window === null || model.form === null) return none(model)
	const slot =
		(isSaved: boolean, form: Model["form"]) =>
		(current: Model): Planned => {
			const payload = form === null ? Option.none() : previewPayload(form, window)
			if (Option.isNone(payload)) return none(current)
			const key = requestKey(context.orgId, "alertRules.preview", payload.value)
			const existing = isSaved ? current.savedPreview : current.preview
			const other = isSaved ? current.preview : current.savedPreview
			if (existing.key !== key && other.key === key)
				return none(isSaved ? { ...current, savedPreview: other } : { ...current, preview: other })
			return Option.match(Keyed.request(existing, key, "Load"), {
				onNone: () => none(current),
				onSome: (next) => ({
					model: isSaved ? { ...current, savedPreview: next } : { ...current, preview: next },
					commands: [FetchEditorPreview({ key, payload: payload.value, isSaved })],
				}),
			})
		}
	// The saved rule's replay is the draft's first preview: one retained read, never refetched.
	const savedPayload = model.savedForm === null ? Option.none() : previewPayload(model.savedForm, window)
	const savedKey = Option.map(savedPayload, (payload) =>
		requestKey(context.orgId, "alertRules.preview", payload),
	)
	const seeded: Model =
		Option.isSome(savedKey) &&
		model.savedPreview.key !== savedKey.value &&
		model.preview.key === savedKey.value
			? { ...model, savedPreview: model.preview }
			: model
	const draft = slot(false, seeded.form)(seeded)
	return isEvaluationChanged(draft.model) ? then(draft, slot(true, draft.model.savedForm)) : draft
}

/** A new rule starts on the destination the org's rules use most, once both lists answered. */
export const applyDefaultDestination = (model: Model): Model => {
	const destinations = destinationsOf(model)
	if (
		model.isDefaultDestinationApplied ||
		model.form === null ||
		destinations.length === 0 ||
		model.rules === null
	)
		return model
	const states = buildRuleStatesByRuleId(model.states ?? [])
	const fallback = pickDefaultDestination(
		destinations,
		model.rules.map((row) => rowToAlertRuleDocument(row, states)),
	)
	const form = model.form
	return {
		...model,
		isDefaultDestinationApplied: true,
		form:
			fallback !== null && form.destinationIds.length === 0
				? { ...form, destinationIds: [fallback] }
				: form,
	}
}

