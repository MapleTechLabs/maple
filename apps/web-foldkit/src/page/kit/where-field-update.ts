import type { QueryBuilderDataSource } from "@maple/query-model"
import {
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
	type WhereClauseAutocompleteScope,
	type WhereClauseAutocompleteValues,
} from "../../lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { Resources } from "../../platform/resources"
import { applied, type CaretMessage, initWhereCaret, isOpenOf, syncedCaret, type WhereCaret } from "./where-autocomplete"
import type { WhereFieldMessage, WhereFields } from "./where-field"
import { FetchWhereFieldValues, PlaceWhereFieldCaret, type WhereValuesRequest } from "./where-field-command"

// `useWhereClauseAutocomplete` for any number of fields: the caret, the open list, the active
// key's values, and an applied suggestion handed back to the owner as the field's new text.

export type ActiveKeyKind = "attr" | "resource"

/** What the owner knows about one field: its text, vocabulary and where its key values come from. */
export type WhereFieldSpec = Readonly<{
	expression: string
	textareaId: string
	dataSource: QueryBuilderDataSource
	scope?: WhereClauseAutocompleteScope
	/** The editor's `values`; the active key's own values are merged in when they are read. */
	values: WhereClauseAutocompleteValues
	/** The read for the key the caret is in (`onActiveAttributeKey`), or null where none is needed. */
	requestOf: (kind: ActiveKeyKind, attributeKey: string) => WhereValuesRequest | null
}>

export type WhereFieldsInputs = Readonly<{
	specOf: (fieldId: string) => WhereFieldSpec | undefined
	orgId: string
}>

type Cmd = Command.Command<WhereFieldMessage, never, Resources>
export type WhereFieldsReturn = Readonly<{
	fields: WhereFields
	commands?: ReadonlyArray<Cmd>
	/** An applied suggestion: the owner sets the field's text as if it were typed. */
	change?: Readonly<{ fieldId: string; expression: string }>
}>

export const caretOf = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec): WhereCaret =>
	fields.carets[fieldId] ?? initWhereCaret(spec.expression)

const slotValues = (fields: WhereFields, slot: string): Array<string> => [
	...Option.getOrElse(AsyncData.getData(fields.values[slot]?.data ?? AsyncData.Idle()), () => []),
]

const valuesFor = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec): WhereClauseAutocompleteValues => {
	const caret = caretOf(fields, fieldId, spec)
	// A key's values exist only while the caret is in its value.
	return {
		...spec.values,
		attributeValues: caret.activeAttributeKey === null ? [] : slotValues(fields, `${fieldId}:attr`),
		resourceAttributeValues:
			caret.activeResourceAttributeKey === null ? [] : slotValues(fields, `${fieldId}:resource`),
	}
}

/** The field's suggestions at its caret. */
export const autocompleteOf = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec): WhereClauseAutocompleteResult =>
	getWhereClauseAutocomplete({
		expression: spec.expression,
		cursor: caretOf(fields, fieldId, spec).cursor,
		dataSource: spec.dataSource,
		scope: spec.scope,
		values: valuesFor(fields, fieldId, spec),
	})

export const isFieldOpen = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec): boolean =>
	isOpenOf(caretOf(fields, fieldId, spec), autocompleteOf(fields, fieldId, spec))

const withCaret = (fields: WhereFields, fieldId: string, caret: WhereCaret): WhereFields => ({
	...fields,
	carets: { ...fields.carets, [fieldId]: caret },
})

/** Each active key asks for its values once (`onActiveAttributeKey`). */
const planValues = (step: WhereFieldsReturn, fieldId: string, spec: WhereFieldSpec, orgId: string): WhereFieldsReturn => {
	const caret = caretOf(step.fields, fieldId, spec)
	const kinds = [
		{ kind: "attr" as const, key: caret.activeAttributeKey },
		{ kind: "resource" as const, key: caret.activeResourceAttributeKey },
	]
	return kinds.reduce<WhereFieldsReturn>((acc, { kind, key }) => {
		const request = key === null ? null : spec.requestOf(kind, key)
		if (request === null) return acc
		const slot = `${fieldId}:${kind}`
		const rk = requestKey(orgId, `where.${request._tag}`, request)
		return Option.match(Keyed.request(acc.fields.values[slot] ?? Keyed.idle(), rk, "Load"), {
			onNone: () => acc,
			onSome: (next) => ({
				...acc,
				fields: { ...acc.fields, values: { ...acc.fields.values, [slot]: next } },
				commands: [...(acc.commands ?? []), FetchWhereFieldValues({ slot, key: rk, request })],
			}),
		})
	}, step)
}

/** The caret after applied text: the keys follow it, the active row stays. */
const appliedCaret = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec, expression: string, cursor: number) => {
	const current = caretOf(fields, fieldId, spec)
	return { ...syncedCaret(current, expression, cursor, spec.dataSource), activeIndex: current.activeIndex }
}

/** `handleApplySuggestion`: the text changes like typing, the caret lands after the insert. */
const appliedSuggestion = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec, index: number, orgId: string) =>
	Option.match(applied(autocompleteOf(fields, fieldId, spec), spec.expression, index), {
		onNone: (): WhereFieldsReturn => ({ fields }),
		onSome: ({ expression, cursor }) =>
			planValues(
				{
					fields: withCaret(fields, fieldId, appliedCaret(fields, fieldId, spec, expression, cursor)),
					commands: [PlaceWhereFieldCaret({ id: spec.textareaId, value: expression, cursor })],
					change: { fieldId, expression },
				},
				fieldId,
				spec,
				orgId,
			),
	})

/** `onKeyIntent("accept")`: the hook's own apply; the caret and keys move, the text does not. */
const pressedTab = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec, orgId: string) =>
	Option.match(applied(autocompleteOf(fields, fieldId, spec), spec.expression, caretOf(fields, fieldId, spec).activeIndex), {
		onNone: (): WhereFieldsReturn => ({ fields }),
		onSome: ({ expression, cursor }) =>
			planValues({ fields: withCaret(fields, fieldId, appliedCaret(fields, fieldId, spec, expression, cursor)) }, fieldId, spec, orgId),
	})

const caretStep = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec, message: CaretMessage, orgId: string) => {
	const caret = caretOf(fields, fieldId, spec)
	switch (message._tag) {
		case "FocusedEditor": {
			const focused = { ...caret, isFocused: true, isDismissed: false, anchor: message.anchor }
			const synced = syncedCaret(focused, spec.expression, message.cursor, spec.dataSource)
			return planValues({ fields: withCaret(fields, fieldId, synced) }, fieldId, spec, orgId)
		}
		case "BlurredEditor":
			return { fields: withCaret(fields, fieldId, { ...caret, isFocused: false }) }
		case "MeasuredAnchor":
			return { fields: withCaret(fields, fieldId, { ...caret, anchor: message.anchor }) }
		case "MovedCaret": {
			// `onKeyUp`: arrows that moved through an open list leave the caret alone.
			const isArrow = message.keyUp === "ArrowDown" || message.keyUp === "ArrowUp"
			if (isArrow && isFieldOpen(fields, fieldId, spec)) return { fields }
			const synced = syncedCaret({ ...caret, anchor: message.anchor }, spec.expression, message.cursor, spec.dataSource)
			return planValues({ fields: withCaret(fields, fieldId, synced) }, fieldId, spec, orgId)
		}
	}
}

/** Steps that act only on an open list. */
const ifOpen = (fields: WhereFields, fieldId: string, spec: WhereFieldSpec, step: () => WhereFieldsReturn) =>
	isFieldOpen(fields, fieldId, spec) ? step() : { fields }

export const updateWhereFields = (
	fields: WhereFields,
	message: WhereFieldMessage,
	inputs: WhereFieldsInputs,
): WhereFieldsReturn => {
	if (message._tag === "CompletedPlaceCaret") return { fields }
	if (message._tag === "CompletedFetchValues") {
		const slot = fields.values[message.slot]
		if (slot === undefined) return { fields }
		return { fields: { ...fields, values: { ...fields.values, [message.slot]: Keyed.accept(slot, message.key, message.result) } } }
	}
	const { fieldId } = message
	const spec = inputs.specOf(fieldId)
	if (spec === undefined) return { fields }
	switch (message._tag) {
		case "GotCaret":
			return caretStep(fields, fieldId, spec, message.message, inputs.orgId)
		case "MovedSuggestion":
			return ifOpen(fields, fieldId, spec, () => {
				const count = autocompleteOf(fields, fieldId, spec).suggestions.length
				const caret = caretOf(fields, fieldId, spec)
				return { fields: withCaret(fields, fieldId, { ...caret, activeIndex: (caret.activeIndex + message.step + count) % count }) }
			})
		case "DismissedSuggestions":
			return ifOpen(fields, fieldId, spec, () => ({
				fields: withCaret(fields, fieldId, { ...caretOf(fields, fieldId, spec), isDismissed: true }),
			}))
		case "AppliedSuggestion":
			return appliedSuggestion(fields, fieldId, spec, message.index, inputs.orgId)
		case "PressedTab":
			return ifOpen(fields, fieldId, spec, () => pressedTab(fields, fieldId, spec, inputs.orgId))
		case "PressedEnter":
			return ifOpen(fields, fieldId, spec, () =>
				appliedSuggestion(fields, fieldId, spec, caretOf(fields, fieldId, spec).activeIndex, inputs.orgId),
			)
	}
}
