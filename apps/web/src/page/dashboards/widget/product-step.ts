import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option } from "effect"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import * as Combobox from "../../../ui/combobox"
import type { PageContext } from "../../contract"
import { toPanelType } from "../kit/chart-registry"
import { FetchSuggestions } from "./command"
import { isProductEventsFunnel } from "./lowering"
import { Message } from "./message"
import type { Model } from "./model"
import { applyProductEdit } from "./product-apply"
import { ProductEdit, type StepScope, type StepTextField } from "./product-edit"
import { SUGGESTION_LOOKUPS, suggestionRequestOf } from "./suggestions"
import type { Return } from "./update"

// The list, funnel and paths panels' steps: their edits, the step inputs' comboboxes, and the
// suggestions the funnel and paths panels fetch while they are shown.

/** The funnel's step editor or the paths panel is on screen (`showFunnelPanel`, `isPaths`). */
export const showsProductPanel = (model: Model): boolean =>
	model.state !== null &&
	(isProductEventsFunnel(model.state) ||
		toPanelType(model.state.visualization, model.state.chartId) === "paths")

/** `suggestionWindow`: the widget's own range, else the board's. */
export const suggestionWindowOf = (model: Model, context: PageContext): TimeWindow | null => {
	const range = model.state?.timeRange ?? model.timeRange
	if (range === null || model.nowMs === null) return null
	const window = resolveTimeRangeWindow(range, {
		snap: true,
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	return window === null ? null : { startTime: window.startTime, endTime: window.endTime }
}

/** The key the event-name lookup shares with the autocomplete provider's, so it is read once. */
export const eventNamesKeyOf = (orgId: string, window: TimeWindow): string => {
	const { operation, data } = suggestionRequestOf("eventNames", window)
	return requestKey(orgId, operation, { data })
}

/** `useFunnelSuggestions`: the three lookups, once a panel that reads them is shown. */
export const requestSuggestions = (model: Model, context: PageContext): Return => {
	const window = showsProductPanel(model) ? suggestionWindowOf(model, context) : null
	if (window === null) return { model }
	return SUGGESTION_LOOKUPS.reduce<Return>(
		(step, lookup) => {
			const { operation, data } = suggestionRequestOf(lookup, window)
			const key = requestKey(context.orgId, operation, { data })
			// The provider already asked for these names over this window: read them once.
			if (
				lookup === "eventNames" &&
				step.model.autocomplete.productEventNames?.key ===
					requestKey(context.orgId, "autocomplete.productEventNames", window)
			)
				return step
			return Option.match(Keyed.request(step.model.suggestions[lookup] ?? Keyed.idle(), key, "Load"), {
				onNone: () => step,
				onSome: (slot) => ({
					model: { ...step.model, suggestions: { ...step.model.suggestions, [lookup]: slot } },
					commands: [...(step.commands ?? []), FetchSuggestions({ key, lookup, window })],
				}),
			})
		},
		{ model, commands: [] },
	)
}

/** A step input's combobox id: scope, step and field. */
export const stepComboId = (scope: StepScope, index: number, field: "eventName" | "pagePath"): string =>
	`widget-step-${scope}-${index}-${field}`

const parseComboId = (
	id: string,
): Option.Option<Readonly<{ scope: StepScope; index: number; field: StepTextField }>> => {
	const match = /^widget-step-(funnel|paths)-(\d+)-(eventName|pagePath)$/.exec(id)
	const [, scope, index, field] = match ?? []
	if (scope === undefined || index === undefined || field === undefined) return Option.none()
	return Option.some({
		scope: scope === "paths" ? "paths" : "funnel",
		index: Number(index),
		field: field === "pagePath" ? "pagePath" : "eventName",
	})
}

/** `SuggestingInput`: the value is whatever was typed, and picking a suggestion types it. */
export const stepComboStep = (
	model: Model,
	context: PageContext,
	id: string,
	message: Combobox.Message,
	edit: (model: Model, context: PageContext, change: ProductEdit) => Return,
): Return => {
	const next = Combobox.update(model.stepCombos[id] ?? Combobox.init(id, "single"), message)
	const lifted: Model = { ...model, stepCombos: { ...model.stepCombos, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotStepComboMessage({ id, message: inner }),
	)
	const typed =
		message._tag === "ChangedInput"
			? Option.some(message.value)
			: next.outMessage?._tag === "ChangedValue"
				? Option.some(next.outMessage.value)
				: Option.none()
	const target = parseComboId(id)
	if (Option.isNone(typed) || Option.isNone(target)) return { model: lifted, commands }
	const edited = edit(lifted, context, ProductEdit.ChangedStepText({ ...target.value, value: typed.value }))
	return { ...edited, commands: [...commands, ...(edited.commands ?? [])] }
}

/** A panel edit applied to the editing state. */
export const applyEdit = (model: Model, edit: ProductEdit): Model =>
	model.state === null ? model : { ...model, state: applyProductEdit(model.state, edit) }
