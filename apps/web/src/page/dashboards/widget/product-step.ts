import { resolveTimeRangeWindow } from "@maple/query-engine"
import { Option, Array as Arr } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import * as Combobox from "@maple/views/ui/combobox"
import type { PageContext } from "../../contract"
import { stepComboUpdate } from "../../kit/funnel-steps"
import { toPanelType } from "../kit/chart-registry"
import { FetchSuggestions } from "./command"
import { isProductEventsFunnel } from "./lowering"
import { Message } from "./message"
import type { Model } from "./model"
import { applyProductEdit } from "./product-apply"
import { ProductEdit } from "./product-edit"
import { SUGGESTION_LOOKUPS, suggestionRequestOf } from "./suggestions"
import type { Return } from "./update"

/** The funnel's step editor or the paths panel is on screen. */
export const showsProductPanel = (model: Model): boolean =>
	model.state !== null &&
	(isProductEventsFunnel(model.state) ||
		toPanelType(model.state.visualization, model.state.chartId) === "paths")

/** The widget's own range, else the board's. */
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

/** The three lookups, once a panel that reads them is shown. */
export const requestSuggestions = (model: Model, context: PageContext): Return => {
	const window = showsProductPanel(model) ? suggestionWindowOf(model, context) : null
	if (window === null) return { model }
	return Arr.reduce<(typeof SUGGESTION_LOOKUPS)[number], Return>(
		SUGGESTION_LOOKUPS,
		{ model, commands: [] },
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
			return Option.match(Keyed.request(Keyed.at(step.model.suggestions, lookup), key, "Load"), {
				onNone: () => step,
				onSome: (slot) => ({
					model: { ...step.model, suggestions: { ...step.model.suggestions, [lookup]: slot } },
					commands: [...(step.commands ?? []), FetchSuggestions({ key, lookup, window })],
				}),
			})
		},
	)
}

/** The value is whatever was typed, and picking a suggestion types it. */
export const stepComboStep = (
	model: Model,
	context: PageContext,
	id: string,
	message: Combobox.Message,
	edit: (model: Model, context: PageContext, change: ProductEdit) => Return,
): Return => {
	const next = stepComboUpdate(model.stepCombos, id, message, (inner) =>
		Message.GotStepComboMessage({ id, message: inner }),
	)
	const lifted: Model = { ...model, stepCombos: next.combos }
	if (Option.isNone(next.edit)) return { model: lifted, commands: next.commands }
	const edited = edit(lifted, context, ProductEdit.Step(next.edit.value))
	return { ...edited, commands: [...next.commands, ...(edited.commands ?? [])] }
}

/** A panel edit applied to the editing state. */
export const applyEdit = (model: Model, edit: ProductEdit): Model =>
	model.state === null ? model : { ...model, state: applyProductEdit(model.state, edit) }
