import { Option, type Result } from "effect"
import type { LoadFailure } from "../../../data/load-failure"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import type { PageContext, PageReturn } from "../../contract"
import type { CatalogSummary } from "./derive"
import { DebounceWhere, FetchAttributeValues, PlaceWhereCaret } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import {
	activeKeyAt,
	applied,
	autocompleteOf,
	type AnchorRect,
	type CaretMessage,
	isOpenOf,
} from "./where-editor"

// `useWhereClauseAutocomplete`'s state transitions for the metric's where editor.

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

/** The scoped attribute keys the editor suggests (`useMetricScopedAutocomplete`). */
export const scopedKeysOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.attributeKeys.data), {
		onNone: () => [],
		onSome: (rows) => rows.map((row) => row.attributeKey),
	})

export const whereAutocompleteOf = (model: Model) =>
	autocompleteOf(model.whereEditor, model.whereInput, scopedKeysOf(model))

export const isWhereOpen = (model: Model): boolean => isOpenOf(model.whereEditor, whereAutocompleteOf(model))

/** `onActiveAttributeKey`: a new key asks for its values; none clears them. */
const withActiveKey = (
	model: Model,
	key: string | null,
	context: PageContext,
	summary: CatalogSummary | null,
): Return => {
	const editor = model.whereEditor
	if (key === editor.activeAttributeKey) return { model }
	const keyed = { ...model, whereEditor: { ...editor, activeAttributeKey: key } }
	if (key === null || summary === null || model.window === null) return { model: keyed }
	const input = {
		...model.window,
		attributeKey: key,
		metricName: summary.metricName,
		metricType: summary.metricType,
	}
	const requestedKey = requestKey(context.orgId, "getMetricAttributeValues", { data: input })
	return Option.match(Keyed.request(editor.attributeValues, requestedKey, "Load"), {
		onNone: () => ({ model: keyed }),
		onSome: (attributeValues) => ({
			model: { ...keyed, whereEditor: { ...keyed.whereEditor, attributeValues } },
			commands: [FetchAttributeValues({ key: requestedKey, input })],
		}),
	})
}

/** `syncCursor`: the caret moved; the list reopens on its first row. */
const synced = (
	model: Model,
	cursor: number,
	anchor: AnchorRect,
	context: PageContext,
	summary: CatalogSummary | null,
): Return =>
	withActiveKey(
		{
			...model,
			whereEditor: { ...model.whereEditor, cursor, anchor, isDismissed: false, activeIndex: 0 },
		},
		activeKeyAt(model.whereInput, cursor),
		context,
		summary,
	)

export const caretMessage = (
	model: Model,
	message: CaretMessage,
	context: PageContext,
	summary: CatalogSummary | null,
): Return => {
	const editor = model.whereEditor
	switch (message._tag) {
		case "FocusedEditor":
			return synced(
				{ ...model, whereEditor: { ...editor, isFocused: true, isDismissed: false } },
				message.cursor,
				message.anchor,
				context,
				summary,
			)
		case "BlurredEditor":
			return { model: { ...model, whereEditor: { ...editor, isFocused: false } } }
		case "MeasuredAnchor":
			return { model: { ...model, whereEditor: { ...editor, anchor: message.anchor } } }
		case "MovedCaret": {
			// `onKeyUp`: arrows that moved through an open list leave the caret alone.
			const isArrow = message.keyUp === "ArrowDown" || message.keyUp === "ArrowUp"
			return isArrow && isOpenOf(editor, whereAutocompleteOf(model))
				? { model }
				: synced(model, message.cursor, message.anchor, context, summary)
		}
	}
}

export const movedSuggestion = (model: Model, step: number): Return => {
	const count = whereAutocompleteOf(model).suggestions.length
	if (count === 0) return { model }
	const activeIndex = (model.whereEditor.activeIndex + step + count) % count
	return { model: { ...model, whereEditor: { ...model.whereEditor, activeIndex } } }
}

export const dismissedSuggestions = (model: Model): Return => ({
	model: { ...model, whereEditor: { ...model.whereEditor, isDismissed: true } },
})

/** `handleApplySuggestion`: the text changes (and commits like typing), the caret lands after it. */
export const appliedSuggestion = (
	model: Model,
	index: number,
	context: PageContext,
	summary: CatalogSummary | null,
): Return =>
	Option.match(applied(whereAutocompleteOf(model), model.whereInput, index), {
		onNone: () => ({ model }),
		onSome: ({ expression, cursor }) => {
			const whereGeneration = model.whereGeneration + 1
			const next: Model = {
				...model,
				whereInput: expression,
				whereGeneration,
				whereEditor: { ...model.whereEditor, cursor, isDismissed: false },
			}
			const keyed = withActiveKey(next, activeKeyAt(expression, cursor), context, summary)
			const commands: ReadonlyArray<Cmd> = [
				DebounceWhere({ generation: whereGeneration }),
				PlaceWhereCaret({ value: expression, cursor }),
				...(keyed.commands ?? []),
			]
			return { model: keyed.model, commands }
		},
	})

export const completedAttributeValues = (
	model: Model,
	key: string,
	result: Result.Result<ReadonlyArray<string>, LoadFailure>,
): Return => ({
	model: {
		...model,
		whereEditor: {
			...model.whereEditor,
			attributeValues: Keyed.accept(model.whereEditor.attributeValues, key, result),
		},
	},
})

/**
 * `onKeyIntent("accept")`: the hook's `applySuggestion`, not the editor's. The caret and active key
 * follow the suggestion, the text does not change; Tab's keyup then re-syncs the real caret.
 */
export const pressedTab = (
	model: Model,
	index: number,
	context: PageContext,
	summary: CatalogSummary | null,
): Return =>
	Option.match(applied(whereAutocompleteOf(model), model.whereInput, index), {
		onNone: () => ({ model }),
		onSome: ({ expression, cursor }) =>
			withActiveKey(
				{ ...model, whereEditor: { ...model.whereEditor, cursor, isDismissed: false } },
				activeKeyAt(expression, cursor),
				context,
				summary,
			),
	})
