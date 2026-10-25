import {
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
} from "../../../lib/query-builder/where-clause-autocomplete"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { KeyedSchema, idle } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { activeKeysAt, AnchorRect } from "../../kit/where-autocomplete"

// The metric page's where editor over the shared autocomplete (`page/kit/where-autocomplete.ts`).

export {
	AnchorRect,
	applied,
	CaretMessage,
	caretEvents,
	isOpenOf,
	placeCaret,
} from "../../kit/where-autocomplete"

/** The where textarea's id (`WhereClauseEditor` in `MetricQueryControls`). */
export const WHERE_TEXTAREA_ID = "metric-where-clause"

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

/** `notifyActiveKeys`: the `attr.*` key the caret is in a value of. */
export const activeKeyAt = (expression: string, cursor: number): string | null =>
	activeKeysAt(expression, cursor, "metrics").attribute
