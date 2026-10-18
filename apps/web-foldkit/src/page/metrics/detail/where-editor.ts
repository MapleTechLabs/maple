import {
	applyWhereClauseSuggestion,
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
} from "@maple/web/lib/query-builder/where-clause-autocomplete"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { Effect, Option, Schema, Stream } from "effect"
import { AsyncData, Dom } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema, idle } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"

// `useWhereClauseAutocomplete` + `WhereClauseEditor`'s suggestion list
// (apps/web/src/hooks/use-where-clause-autocomplete.ts, components/query-builder/where-clause-editor.tsx).

/** The where textarea's id (`WhereClauseEditor` in `MetricQueryControls`). */
export const WHERE_TEXTAREA_ID = "metric-where-clause"

/** The textarea's box when the caret last moved: the fixed listbox is anchored to it. */
export const AnchorRect = Schema.Struct({
	left: Schema.Number,
	top: Schema.Number,
	bottom: Schema.Number,
	width: Schema.Number,
	viewportHeight: Schema.Number,
})
export type AnchorRect = typeof AnchorRect.Type

export const WhereEditor = Schema.Struct({
	cursor: Schema.Number,
	isFocused: Schema.Boolean,
	isDismissed: Schema.Boolean,
	activeIndex: Schema.Number,
	/** `onActiveAttributeKey`: the `attr.*` key whose value the caret is in. */
	activeAttributeKey: Schema.NullOr(Schema.String),
	/** `getMetricAttributeValuesResultAtom` for that key. */
	attributeValues: KeyedSchema(Schema.Array(Schema.String), LoadFailure),
	anchor: Schema.NullOr(AnchorRect),
})
export type WhereEditor = typeof WhereEditor.Type

export const initWhereEditor = (expression: string): WhereEditor => ({
	cursor: expression.length,
	isFocused: false,
	isDismissed: false,
	activeIndex: 0,
	activeAttributeKey: null,
	attributeValues: idle(),
	anchor: null,
})

/** What the native textarea reports (`OnInput` carries no caret). */
export const CaretMessage = defineMessageUnion({
	MovedCaret: { cursor: Schema.Number, anchor: AnchorRect, keyUp: Schema.NullOr(Schema.String) },
	FocusedEditor: { cursor: Schema.Number, anchor: AnchorRect },
	BlurredEditor: {},
})
export type CaretMessage = typeof CaretMessage.Type

const anchorOf = (element: HTMLTextAreaElement): AnchorRect => {
	const rect = element.getBoundingClientRect()
	return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, viewportHeight: window.innerHeight }
}

const caretOf = (element: HTMLTextAreaElement) => element.selectionStart ?? element.value.length

/** `onFocus`, `onBlur`, and the caret syncs (`onChange`, `onClick`, `onSelect`, `onKeyUp`). */
export const caretEvents = (element: Element): Stream.Stream<CaretMessage> => {
	if (!(element instanceof HTMLTextAreaElement)) return Stream.empty
	const moved = (keyUp: string | null) => CaretMessage.MovedCaret({ cursor: caretOf(element), anchor: anchorOf(element), keyUp })
	const on = (type: "input" | "click" | "select") =>
		Dom.streamFromEventFilterMap({ target: element, type, filterMapEvent: () => Option.some(moved(null)) })
	const streams: ReadonlyArray<Stream.Stream<CaretMessage>> = [
			on("input"),
			on("click"),
			on("select"),
			Dom.streamFromEventFilterMap({
				target: element,
				type: "keyup",
				filterMapEvent: (event) => Option.some(moved(event.key)),
			}),
			Dom.streamFromEventFilterMap({
				target: element,
				type: "focus",
				filterMapEvent: () =>
					Option.some(CaretMessage.FocusedEditor({ cursor: caretOf(element), anchor: anchorOf(element) })),
			}),
			Dom.streamFromEventFilterMap({
				target: element,
				type: "blur",
				filterMapEvent: () => Option.some(CaretMessage.BlurredEditor()),
			}),
		]
	return Stream.mergeAll(streams, { concurrency: "unbounded" })
}

/**
 * `handleApplySuggestion`: the applied text in the textarea and the caret after the insert, before
 * the key's keyup reads the caret back (React's controlled value lands in the same task).
 */
export const placeCaret = (id: string, value: string, cursor: number) =>
	Effect.sync(() => {
		const element = document.getElementById(id)
		if (!(element instanceof HTMLTextAreaElement)) return
		element.value = value
		element.focus()
		element.setSelectionRange(cursor, cursor)
	})

// DERIVE

/** `useMetricScopedAutocomplete` over the provider's `metrics` values. */
export const autocompleteOf = (
	editor: WhereEditor,
	expression: string,
	attributeKeys: ReadonlyArray<string>,
): WhereClauseAutocompleteResult =>
	getWhereClauseAutocomplete({
		expression,
		cursor: editor.cursor,
		dataSource: "metrics",
		values: {
			metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
			attributeKeys: [...attributeKeys],
			attributeValues:
				editor.activeAttributeKey === null
					? []
					: [...Option.getOrElse(AsyncData.getData(editor.attributeValues.data), () => [])],
		},
	})

export const isOpenOf = (editor: WhereEditor, autocomplete: WhereClauseAutocompleteResult): boolean =>
	editor.isFocused && !editor.isDismissed && autocomplete.suggestions.length > 0

/** `notifyActiveKeys`: the `attr.*` key the caret is in a value of. */
export const activeKeyAt = (expression: string, cursor: number): string | null => {
	const at = getWhereClauseAutocomplete({ expression, cursor, dataSource: "metrics" })
	return at.context === "value" && at.key?.startsWith("attr.") === true ? at.key.slice(5) : null
}

/** `applySuggestion(index)`: the new text and caret, or nothing past the list. */
export const applied = (autocomplete: WhereClauseAutocompleteResult, expression: string, index: number) =>
	Option.map(Option.fromNullishOr(autocomplete.suggestions[index]), (suggestion) =>
		applyWhereClauseSuggestion({
			expression,
			context: autocomplete.context,
			replaceStart: autocomplete.replaceStart,
			replaceEnd: autocomplete.replaceEnd,
			suggestion,
		}),
	)

const LISTBOX_MAX_HEIGHT = 208
const LISTBOX_GAP = 4
const LISTBOX_MIN_SPACE_BELOW = 160

/** `computeListboxPosition`: below the textarea, or above when there is more room there. */
export const listboxStyle = (anchor: AnchorRect): Readonly<Record<string, string>> => {
	const spaceBelow = anchor.viewportHeight - anchor.bottom - LISTBOX_GAP
	const spaceAbove = anchor.top - LISTBOX_GAP
	const flipUp = spaceBelow < LISTBOX_MIN_SPACE_BELOW && spaceAbove > spaceBelow
	const available = flipUp ? spaceAbove : spaceBelow
	return {
		left: `${anchor.left}px`,
		width: `${anchor.width}px`,
		"max-height": `${Math.max(0, Math.min(LISTBOX_MAX_HEIGHT, available - LISTBOX_GAP))}px`,
		...(flipUp
			? { bottom: `${anchor.viewportHeight - anchor.top + LISTBOX_GAP}px` }
			: { top: `${anchor.bottom + LISTBOX_GAP}px` }),
	}
}
