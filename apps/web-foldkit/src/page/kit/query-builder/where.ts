import { toQueryBuilderMetricType } from "@maple/query-model"
import {
	getWhereClauseAutocomplete,
	type WhereClauseAutocompleteResult,
	type WhereClauseAutocompleteValues,
} from "@maple/web/lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { applied, type CaretMessage, initWhereCaret, isOpenOf, syncedCaret, type WhereCaret } from "../where-autocomplete"
import { QueryChange } from "./change"
import type { QueryDraft } from "./draft"
import { Message, type Model, OutMessage } from "./panel-message"
import { FetchWhereValues, PlaceWhereCaret, whereTextareaId, type WhereValuesRequest } from "./where-command"

export { whereTextareaId } from "./where-command"

// `WhereClauseEditor` inside a `QueryPanel`: the caret, the open list, and the active key's values.

/** What the host knows that the panel needs to complete a where clause. */
export type PanelInputs = Readonly<{
	queryOf: (queryId: string) => QueryDraft | undefined
	/** `autocompleteValues[query.dataSource]`, metric-scoped keys included. */
	baseValuesOf: (query: QueryDraft) => WhereClauseAutocompleteValues
	orgId: string
	/** The provider's window once it is active; span and resource values are not asked for before. */
	window: TimeWindow | null
}>

type Cmd = Command.Command<Message, never, Resources>
type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Cmd>; outMessage?: OutMessage }>

export const caretOf = (model: Model, query: QueryDraft): WhereCaret =>
	model.whereCarets[query.id] ?? initWhereCaret(query.whereClause)

const slotValues = (model: Model, slot: string): Array<string> => [
	...Option.getOrElse(AsyncData.getData(model.whereValues[slot]?.data ?? AsyncData.Idle()), () => []),
]

/** `useMetricScopedAutocomplete`: a picked metric's values replace the provider's. */
const isScopedMetric = (query: QueryDraft) =>
	query.dataSource === "metrics" && query.metricName !== "" && toQueryBuilderMetricType(query.metricType) !== null

export const valuesFor = (
	model: Model,
	query: QueryDraft,
	base: WhereClauseAutocompleteValues,
): WhereClauseAutocompleteValues => {
	const caret = caretOf(model, query)
	if (query.dataSource === "metrics")
		return isScopedMetric(query)
			? { ...base, attributeValues: caret.activeAttributeKey === null ? [] : slotValues(model, `${query.id}:attr`) }
			: base
	if (query.dataSource === "product_events") return base
	return {
		...base,
		attributeValues: caret.activeAttributeKey === null ? [] : slotValues(model, `${query.id}:attr`),
		resourceAttributeValues:
			caret.activeResourceAttributeKey === null ? [] : slotValues(model, `${query.id}:resource`),
	}
}

/** The editor's suggestions over the host's `base` values and the panel's own active-key values. */
export const whereAutocompleteOf = (
	model: Model,
	query: QueryDraft,
	base: WhereClauseAutocompleteValues,
): WhereClauseAutocompleteResult =>
	getWhereClauseAutocomplete({
		expression: query.whereClause,
		cursor: caretOf(model, query).cursor,
		dataSource: query.dataSource,
		values: valuesFor(model, query, base),
	})

const autocompleteFor = (model: Model, query: QueryDraft, inputs: PanelInputs) =>
	whereAutocompleteOf(model, query, inputs.baseValuesOf(query))

const isWhereOpen = (model: Model, query: QueryDraft, inputs: PanelInputs): boolean =>
	isOpenOf(caretOf(model, query), autocompleteFor(model, query, inputs))

const withCaret = (model: Model, queryId: string, caret: WhereCaret): Model => ({
	...model,
	whereCarets: { ...model.whereCarets, [queryId]: caret },
})

/** The read for one active key, or none where legacy reads nothing. */
const requestOf = (
	query: QueryDraft,
	kind: "attr" | "resource",
	attributeKey: string,
	window: TimeWindow | null,
): WhereValuesRequest | null => {
	if (query.dataSource === "metrics") {
		const metricType = toQueryBuilderMetricType(query.metricType)
		return kind === "attr" && query.metricName !== "" && metricType !== null
			? { _tag: "Metric", attributeKey, metricName: query.metricName, metricType }
			: null
	}
	if (query.dataSource === "product_events" || window === null) return null
	const range = { startTime: window.startTime, endTime: window.endTime, attributeKey }
	return kind === "attr" ? { _tag: "Span", ...range } : { _tag: "Resource", ...range }
}

/** Each editor's active keys ask for their values once (`onActiveAttributeKey`). */
const planValues = (step: Return, query: QueryDraft, inputs: PanelInputs): Return => {
	const caret = caretOf(step.model, query)
	const kinds = [
		{ kind: "attr" as const, key: caret.activeAttributeKey },
		{ kind: "resource" as const, key: caret.activeResourceAttributeKey },
	]
	return kinds.reduce<Return>((acc, { kind, key }) => {
		const request = key === null ? null : requestOf(query, kind, key, inputs.window)
		if (request === null) return acc
		const slot = `${query.id}:${kind}`
		const rk = requestKey(inputs.orgId, `where.${request._tag}`, request)
		return Option.match(Keyed.request(acc.model.whereValues[slot] ?? Keyed.idle(), rk, "Load"), {
			onNone: () => acc,
			onSome: (next) => ({
				...acc,
				model: { ...acc.model, whereValues: { ...acc.model.whereValues, [slot]: next } },
				commands: [...(acc.commands ?? []), FetchWhereValues({ slot, key: rk, request })],
			}),
		})
	}, step)
}

/** `handleApplySuggestion`: the text changes like typing, the caret lands after the insert. */
const appliedSuggestion = (model: Model, query: QueryDraft, index: number, inputs: PanelInputs): Return =>
	Option.match(applied(autocompleteFor(model, query, inputs), query.whereClause, index), {
		onNone: () => ({ model }),
		onSome: ({ expression, cursor }) => {
			const caret = { ...syncedCaret(caretOf(model, query), expression, cursor, query.dataSource), activeIndex: caretOf(model, query).activeIndex }
			return planValues(
				{
					model: withCaret(model, query.id, caret),
					commands: [PlaceWhereCaret({ id: whereTextareaId(query.id), value: expression, cursor })],
					outMessage: OutMessage.ChangedQuery({
						queryId: query.id,
						change: QueryChange.SetText({ field: "whereClause", value: expression }),
					}),
				},
				query,
				inputs,
			)
		},
	})

/** `onKeyIntent("accept")`: the hook's own apply; the caret and keys move, the text does not. */
const pressedTab = (model: Model, query: QueryDraft, inputs: PanelInputs): Return =>
	Option.match(applied(autocompleteFor(model, query, inputs), query.whereClause, caretOf(model, query).activeIndex), {
		onNone: () => ({ model }),
		onSome: ({ expression, cursor }) => {
			const current = caretOf(model, query)
			const synced = syncedCaret(current, expression, cursor, query.dataSource)
			return planValues({ model: withCaret(model, query.id, { ...synced, activeIndex: current.activeIndex }) }, query, inputs)
		},
	})

const caretStep = (model: Model, query: QueryDraft, message: CaretMessage, inputs: PanelInputs): Return => {
	const caret = caretOf(model, query)
	switch (message._tag) {
		case "FocusedEditor": {
			const focused = { ...caret, isFocused: true, isDismissed: false, anchor: message.anchor }
			const synced = syncedCaret(focused, query.whereClause, message.cursor, query.dataSource)
			return planValues({ model: withCaret(model, query.id, synced) }, query, inputs)
		}
		case "BlurredEditor":
			return { model: withCaret(model, query.id, { ...caret, isFocused: false }) }
		case "MeasuredAnchor":
			return { model: withCaret(model, query.id, { ...caret, anchor: message.anchor }) }
		case "MovedCaret": {
			// `onKeyUp`: arrows that moved through an open list leave the caret alone.
			const isArrow = message.keyUp === "ArrowDown" || message.keyUp === "ArrowUp"
			if (isArrow && isWhereOpen(model, query, inputs)) return { model }
			const moved = { ...caret, anchor: message.anchor }
			const synced = syncedCaret(moved, query.whereClause, message.cursor, query.dataSource)
			return planValues({ model: withCaret(model, query.id, synced) }, query, inputs)
		}
	}
}

const ifOpen = (model: Model, query: QueryDraft | undefined, inputs: PanelInputs, step: (query: QueryDraft) => Return) =>
	query === undefined || !isWhereOpen(model, query, inputs) ? { model } : step(query)

/** The where editor's Messages; `null` for every other panel Message. */
export const whereStep = (model: Model, message: Message, inputs: PanelInputs): Return | null => {
	const query = "queryId" in message ? inputs.queryOf(message.queryId) : undefined
	switch (message._tag) {
		case "CompletedPlaceWhereCaret":
			return { model }
		case "CompletedFetchWhereValues": {
			const slot = model.whereValues[message.slot]
			if (slot === undefined) return { model }
			const accepted = Keyed.accept(slot, message.key, message.result)
			return { model: { ...model, whereValues: { ...model.whereValues, [message.slot]: accepted } } }
		}
		case "GotWhereCaret":
			return query === undefined ? { model } : caretStep(model, query, message.message, inputs)
		case "MovedWhereSuggestion":
			return ifOpen(model, query, inputs, (open) => {
				const count = autocompleteFor(model, open, inputs).suggestions.length
				const caret = caretOf(model, open)
				const activeIndex = (caret.activeIndex + message.step + count) % count
				return { model: withCaret(model, open.id, { ...caret, activeIndex }) }
			})
		case "DismissedWhereSuggestions":
			return ifOpen(model, query, inputs, (open) => ({
				model: withCaret(model, open.id, { ...caretOf(model, open), isDismissed: true }),
			}))
		case "AppliedWhereSuggestion":
			return query === undefined ? { model } : appliedSuggestion(model, query, message.index, inputs)
		case "PressedWhereTab":
			return ifOpen(model, query, inputs, (open) => pressedTab(model, open, inputs))
		// Where clauses are single-line: Enter only applies an open list's active row.
		case "PressedWhereEnter":
			return ifOpen(model, query, inputs, (open) =>
				appliedSuggestion(model, open, caretOf(model, open).activeIndex, inputs),
			)
		default:
			return null
	}
}
