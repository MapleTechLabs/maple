import {
	applyWhereClauseSuggestion,
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
} from "../../lib/query-builder/where-clause-autocomplete"
import type { QueryBuilderDataSource } from "@maple/query-model"
import { Effect, Option, Schema, Stream } from "effect"
import { Dom } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// The where clause autocomplete and its suggestion list, shared by every where editor
// (see lib/query-builder/where-clause-autocomplete.ts).

/** The textarea's box when the caret last moved: the fixed listbox is anchored to it. */
export const AnchorRect = Schema.Struct({
	left: Schema.Number,
	top: Schema.Number,
	bottom: Schema.Number,
	width: Schema.Number,
	viewportHeight: Schema.Number,
})
export type AnchorRect = typeof AnchorRect.Type

/** What the native textarea reports (`OnInput` carries no caret). */
export const CaretMessage = defineMessageUnion({
	MovedCaret: { cursor: Schema.Number, anchor: AnchorRect, keyUp: Schema.NullOr(Schema.String) },
	FocusedEditor: { cursor: Schema.Number, anchor: AnchorRect },
	BlurredEditor: {},
	/** The open list re-measured its textarea (resize or scroll). */
	MeasuredAnchor: { anchor: AnchorRect },
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
	const moved = (keyUp: string | null) =>
		CaretMessage.MovedCaret({ cursor: caretOf(element), anchor: anchorOf(element), keyUp })
	const on = (type: "input" | "click" | "select") =>
		Dom.streamFromEventFilterMap({ target: element, type, filterMapEvent: () => Option.some(moved(null)) })
	const streams: ReadonlyArray<Stream.Stream<CaretMessage>> = [
		on("input"),
		on("click"),
		on("select"),
		Dom.streamFromEventFilterMap({ target: element, type: "keyup", filterMapEvent: (event) => Option.some(moved(event.key)) }),
		Dom.streamFromEventFilterMap({
			target: element,
			type: "focus",
			filterMapEvent: () => Option.some(CaretMessage.FocusedEditor({ cursor: caretOf(element), anchor: anchorOf(element) })),
		}),
		Dom.streamFromEventFilterMap({ target: element, type: "blur", filterMapEvent: () => Option.some(CaretMessage.BlurredEditor()) }),
	]
	return Stream.mergeAll(streams, { concurrency: "unbounded" })
}

/** `onMouseDown={(e) => e.preventDefault()}` on the list: picking a suggestion keeps the focus. */
export const keepFocusEvents = <M>(element: Element): Stream.Stream<M> =>
	Dom.streamFromEventFilterMap({
		target: element,
		type: "mousedown",
		filterMapEvent: (event): Option.Option<M> => {
			event.preventDefault()
			return Option.none()
		},
	})

/**
 * The open list's re-anchoring (`measure` in `WhereClauseEditor`): the textarea's box again on
 * window resize and on any scroll (capture, so scrolling ancestors count too).
 */
const anchorEvents = (textareaId: string): Stream.Stream<CaretMessage> => {
	const measured = (): Option.Option<CaretMessage> => {
		const element = document.getElementById(textareaId)
		return element instanceof HTMLTextAreaElement
			? Option.some(CaretMessage.MeasuredAnchor({ anchor: anchorOf(element) }))
			: Option.none()
	}
	const streams: ReadonlyArray<Stream.Stream<CaretMessage>> = [
		Dom.streamFromEventFilterMap({ target: window, type: "resize", filterMapEvent: measured }),
		Dom.streamFromEventFilterMap({ target: window, type: "scroll", filterMapEvent: measured, options: { capture: true } }),
	]
	return Stream.mergeAll(streams, { concurrency: "unbounded" })
}

/** The open list's Mount: it keeps the textarea focused and follows it. */
export const listboxEvents = (element: Element, textareaId: string): Stream.Stream<CaretMessage> =>
	Stream.merge(keepFocusEvents<CaretMessage>(element), anchorEvents(textareaId))

/**
 * `handleApplySuggestion`: the applied text in the textarea and the caret after the insert, before
 * the key's keyup reads the caret back (the value lands in the same task).
 */
export const placeCaret = (id: string, value: string, cursor: number) =>
	Effect.sync(() => {
		const element = document.getElementById(id)
		if (!(element instanceof HTMLTextAreaElement)) return
		element.value = value
		element.focus()
		element.setSelectionRange(cursor, cursor)
	})

/** The editor's caret, focus and list state; the expression stays with its owner. */
export const WhereCaret = Schema.Struct({
	cursor: Schema.Number,
	isFocused: Schema.Boolean,
	isDismissed: Schema.Boolean,
	activeIndex: Schema.Number,
	anchor: Schema.NullOr(AnchorRect),
	/** `onActiveAttributeKey` / `onActiveResourceAttributeKey`: the key whose value the caret is in. */
	activeAttributeKey: Schema.NullOr(Schema.String),
	activeResourceAttributeKey: Schema.NullOr(Schema.String),
})
export type WhereCaret = typeof WhereCaret.Type

export const initWhereCaret = (expression: string): WhereCaret => ({
	cursor: expression.length,
	isFocused: false,
	isDismissed: false,
	activeIndex: 0,
	anchor: null,
	activeAttributeKey: null,
	activeResourceAttributeKey: null,
})

export const isOpenOf = (
	caret: Readonly<{ isFocused: boolean; isDismissed: boolean }>,
	autocomplete: WhereClauseAutocompleteResult,
): boolean => caret.isFocused && !caret.isDismissed && autocomplete.suggestions.length > 0

/** `notifyActiveKeys`: the `attr.*` and `resource.*` keys the caret is in a value of. */
export const activeKeysAt = (expression: string, cursor: number, dataSource: QueryBuilderDataSource) => {
	const at = getWhereClauseAutocomplete({ expression, cursor, dataSource })
	const key = at.context === "value" ? at.key : null
	return {
		attribute: key?.startsWith("attr.") === true ? key.slice(5) : null,
		resource: key?.startsWith("resource.") === true ? key.slice(9) : null,
	}
}

/** The caret moved to `cursor`: the list reopens on its first row and the active keys follow. */
export const syncedCaret = (
	caret: WhereCaret,
	expression: string,
	cursor: number,
	dataSource: QueryBuilderDataSource,
): WhereCaret => {
	const keys = activeKeysAt(expression, cursor, dataSource)
	return {
		...caret,
		cursor,
		isDismissed: false,
		activeIndex: 0,
		activeAttributeKey: keys.attribute,
		activeResourceAttributeKey: keys.resource,
	}
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
