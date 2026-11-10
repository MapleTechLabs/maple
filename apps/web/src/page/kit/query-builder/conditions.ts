import { Operator } from "@maple/domain/where-clause"
import { Command, type Update } from "foldkit"
import * as Combobox from "@maple/views/ui/combobox"
import * as Select from "@maple/views/ui/select"
import type { Resources } from "../../../platform/resources"
import { QueryChange } from "./change"
import {
	canMatchAnyOf,
	type FieldDrill,
	fieldOf,
	fieldPickerItems,
	type FieldPickerItem,
	fieldsOf,
	operatorsOf,
} from "./condition-fields"
import {
	type ConditionRow,
	isAnyOf,
	isNoneOf,
	isUnspellable,
	isValueless,
	nextRowId,
	parseConditionRows,
	printConditionRowsOver,
	sameConditions,
} from "./condition-rows"
import type { QueryDraft } from "./draft"
import { Message, type Model, OutMessage, type WhereMode } from "./panel-message"
import type { PanelInputs } from "./where"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

// The condition builder's steps: an edit that changes the conditions leaves as the query's
// where-clause edit, rewriting only the clauses it touched, so previews and saving see only the string.

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export type PickerPart = "field" | "values"

export const conditionPickerId = (queryId: string, rowId: string, part: PickerPart): string =>
	`cond-${queryId}-${rowId}-${part}`

const OPERATOR_SELECT = "whereOp"

export const operatorSelectId = (queryId: string, rowId: string): string =>
	`${OPERATOR_SELECT}:${queryId}:${rowId}`

export const isOperatorSelect = (id: string): boolean => Str.startsWith(`${OPERATOR_SELECT}:`)(id)

/** The kept rows while they still mean the query's where clause, else none. */
const keptRowsOf = (model: Model, query: QueryDraft): Option.Option<ReadonlyArray<ConditionRow>> =>
	Option.flatMap(Option.fromNullishOr(model.conditions[query.id]), (kept) =>
		Option.filter(parseConditionRows(query.whereClause), (parsed) => sameConditions(parsed, kept)).pipe(
			Option.map(() => kept),
		),
	)

/** The rows a query shows: the kept ones while they mean its where clause, else a fresh parse. */
export const conditionRowsOf = (
	model: Model,
	query: QueryDraft,
): Option.Option<ReadonlyArray<ConditionRow>> =>
	Option.orElse(keptRowsOf(model, query), () => parseConditionRows(query.whereClause))

/** A fresh parse renumbers the rows: drop the query's rows, pickers, drills and operator selects. */
export const withoutBuilderState = (model: Model, queryId: string): Model => {
	const pickerPrefix = `cond-${queryId}-`
	return {
		...model,
		conditions: Rec.remove(model.conditions, queryId),
		conditionPickers: Rec.filter(model.conditionPickers, (_, id) => !Str.startsWith(pickerPrefix)(id)),
		fieldDrills: Rec.filter(model.fieldDrills, (_, id) => !Str.startsWith(pickerPrefix)(id)),
		selects: Rec.filter(model.selects, (_, id) => !Str.startsWith(`${OPERATOR_SELECT}:${queryId}:`)(id)),
	}
}

/** The editor a query shows; only a Builder click leaves Text once the text editor was used. */
export const whereModeOf = (model: Model, query: QueryDraft): WhereMode =>
	model.whereModes[query.id] ?? "builder"

/** The text editor was typed in: it stays the editor, and the rows read afresh later. */
export const typedInTextEditor = (model: Model, queryId: string): Model => ({
	...withoutBuilderState(model, queryId),
	whereModes: { ...model.whereModes, [queryId]: "text" },
})

/** Keeps the rows; the where clause changes only when the complete conditions do. */
const emitted = (
	model: Model,
	query: QueryDraft,
	before: ReadonlyArray<ConditionRow>,
	rows: ReadonlyArray<ConditionRow>,
	commands?: Return["commands"],
): Return => {
	const kept: Model = { ...model, conditions: { ...model.conditions, [query.id]: rows } }
	const withCommands = commands === undefined ? undefined : { commands }
	if (sameConditions(before, rows)) return { model: kept, ...withCommands }
	return {
		model: kept,
		...withCommands,
		outMessage: OutMessage.ChangedQuery({
			queryId: query.id,
			change: QueryChange.SetText({
				field: "whereClause",
				value: printConditionRowsOver(rows, query.whereClause),
			}),
		}),
	}
}

type RowContext = Readonly<{ model: Model; query: QueryDraft; rows: ReadonlyArray<ConditionRow> }>

const withRows = (
	model: Model,
	queryId: string,
	inputs: PanelInputs | undefined,
	step: (context: RowContext) => Return,
): Return => {
	const query = inputs?.queryOf(queryId)
	if (query === undefined) return { model }
	return Option.match(keptRowsOf(model, query), {
		onSome: (rows) => step({ model, query, rows }),
		// Stale kept rows mean the ids renumber: their pickers go. The fresh rows are kept either way.
		onNone: () =>
			Option.match(parseConditionRows(query.whereClause), {
				onNone: () => ({ model }),
				onSome: (rows) => {
					const fresh =
						model.conditions[queryId] === undefined ? model : withoutBuilderState(model, queryId)
					return step({
						model: { ...fresh, conditions: { ...fresh.conditions, [queryId]: rows } },
						query,
						rows,
					})
				},
			}),
	})
}

const withRow = (
	model: Model,
	queryId: string,
	rowId: string,
	inputs: PanelInputs | undefined,
	step: (context: RowContext & Readonly<{ row: ConditionRow }>) => Return,
): Return =>
	withRows(model, queryId, inputs, (context) =>
		Option.match(
			Arr.findFirst(context.rows, (row) => row.id === rowId),
			{ onNone: () => ({ model: context.model }), onSome: (row) => step({ ...context, row }) },
		),
	)

const replaced = (rows: ReadonlyArray<ConditionRow>, next: ConditionRow): ReadonlyArray<ConditionRow> =>
	Arr.map(rows, (row) => (row.id === next.id ? next : row))

export const changedWhereMode = (model: Model, queryId: string, mode: WhereMode): Return => ({
	model: { ...withoutBuilderState(model, queryId), whereModes: { ...model.whereModes, [queryId]: mode } },
})

/** A new row opens its field picker, as the first thing to choose; the clause is unchanged. */
export const addedCondition = (model: Model, queryId: string, inputs: PanelInputs | undefined): Return =>
	withRows(model, queryId, inputs, ({ model: current, query, rows }) => {
		const id = nextRowId(rows)
		const pickerId = conditionPickerId(queryId, id, "field")
		const opened: Model = {
			...current,
			conditionPickers: {
				...current.conditionPickers,
				[pickerId]: { ...Combobox.init(pickerId, "single", { isOpen: true }), highlighted: 0 },
			},
		}
		return emitted(opened, query, rows, [...rows, { id, key: "", operator: "=", values: [] }])
	})

export const removedCondition = (
	model: Model,
	queryId: string,
	rowId: string,
	inputs: PanelInputs | undefined,
): Return =>
	withRows(model, queryId, inputs, ({ model: current, query, rows }) => {
		const pickerIds = [
			conditionPickerId(queryId, rowId, "field"),
			conditionPickerId(queryId, rowId, "values"),
		]
		return emitted(
			{
				...current,
				conditionPickers: Rec.filter(current.conditionPickers, (_, id) => !pickerIds.includes(id)),
				selects: Rec.remove(current.selects, operatorSelectId(queryId, rowId)),
			},
			query,
			rows,
			Arr.filter(rows, (row) => row.id !== rowId),
		)
	})

/** The value an Enter or a click picks from the list the view drew. */
const pickedValue = (current: Combobox.Model, message: Combobox.Message): string | null => {
	if (message._tag === "ClickedItem") return message.value
	if (message._tag === "PressedInputKey" && message.key === "Enter" && current.highlighted !== null)
		return message.items[current.highlighted] ?? null
	return null
}

/** The option an open field list highlights: the picked field when listed, else the first that is not "All fields". */
const fieldHighlightOf = (
	items: ReadonlyArray<FieldPickerItem>,
	key: string,
	from?: FieldDrill,
): number | null =>
	Option.getOrNull(
		Option.orElse(
			Arr.findFirstIndex(items, (item) => item.value === key),
			() =>
				Option.orElse(
					// Back out of a group: its own row, where the highlight was before drilling in.
					Arr.findFirstIndex(items, (item) => item._tag === "Group" && item.group === from),
					() =>
						Option.orElse(
							Arr.findFirstIndex(items, (item) => item._tag !== "Back"),
							() => (items.length === 0 ? Option.none() : Option.some(0)),
						),
				),
		),
	)

/**
 * The field picker: a group or "All fields" drills without closing; a field sets the row's key.
 * An open list always has a highlight, so Enter picks without an arrow key first.
 */
export const fieldStep = (
	model: Model,
	queryId: string,
	rowId: string,
	message: Combobox.Message,
	inputs: PanelInputs | undefined,
): Return =>
	withRow(model, queryId, rowId, inputs, ({ model: base, query, rows, row }) => {
		const id = conditionPickerId(queryId, rowId, "field")
		const stored = base.conditionPickers[id] ?? Combobox.init(id, "single")
		const current = { ...stored, selected: row.key === "" ? [] : [row.key] }
		const drill = base.fieldDrills[id] ?? "all"
		const fields = fieldsOf(query.dataSource, inputs?.baseValuesOf(query) ?? {})
		const items = fieldPickerItems(fields, drill, Combobox.queryOf(current))
		const picked = Option.flatMap(Option.fromNullishOr(pickedValue(current, message)), (value) =>
			Arr.findFirst(items, (item) => item.value === value),
		)
		const navigated = Option.flatMap(picked, (item) =>
			item._tag === "Group"
				? Option.some(item.group)
				: item._tag === "Back"
					? Option.some("all" as const)
					: Option.none(),
		)
		if (Option.isSome(navigated))
			return {
				model: {
					...base,
					conditionPickers: {
						...base.conditionPickers,
						[id]: {
							...current,
							inputValue: "",
							highlighted: fieldHighlightOf(
								fieldPickerItems(fields, navigated.value, ""),
								row.key,
								drill,
							),
						},
					},
					fieldDrills: { ...base.fieldDrills, [id]: navigated.value },
				},
			}
		const next = Combobox.update(current, message)
		// Opening, and typing a search, start from the default highlight.
		const needsHighlight =
			next.model.isOpen && (next.model.highlighted === null || message._tag === "ChangedInput")
		const picker = needsHighlight
			? {
					...next.model,
					highlighted: fieldHighlightOf(
						fieldPickerItems(fields, drill, Combobox.queryOf(next.model)),
						row.key,
					),
				}
			: next.model
		const lifted: Model = {
			...base,
			conditionPickers: { ...base.conditionPickers, [id]: picker },
			fieldDrills: picker.isOpen ? base.fieldDrills : Rec.remove(base.fieldDrills, id),
		}
		const commands = Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotConditionField({ queryId, rowId, message: inner }),
		)
		const key = Option.getOrNull(
			Option.flatMap(picked, (item) =>
				item._tag === "Field"
					? Option.some(item.field.key)
					: item._tag === "Custom"
						? Option.some(item.key)
						: Option.none(),
			),
		)
		if (next.outMessage?._tag !== "ChangedValue" || key === null || key === row.key)
			return { model: lifted, commands }
		const operators = operatorsOf(fieldOf(key, query.dataSource), query.dataSource)
		const operator = operators.includes(row.operator) ? row.operator : (operators[0] ?? "=")
		return emitted(lifted, query, rows, replaced(rows, { ...row, key, operator, values: [] }), commands)
	})

/**
 * Whether a row holds several values: "is" only where the engine ORs (attribute filters),
 * "is not" as AND-ed excludes except on product events, whose excludes replace each other.
 */
export const holdsManyValues = (row: Pick<ConditionRow, "key" | "operator">, query: QueryDraft): boolean =>
	isAnyOf(row.operator)
		? canMatchAnyOf(fieldOf(row.key, query.dataSource), query.dataSource)
		: isNoneOf(row.operator) && query.dataSource !== "product_events"

/** The value picker's Model for the row: a multiple picker with chips, or a single one holding the value. */
export const valuePickerOf = (model: Model, query: QueryDraft, row: ConditionRow): Combobox.Model => {
	const id = conditionPickerId(query.id, row.id, "values")
	const mode = holdsManyValues(row, query) ? "multiple" : "single"
	const stored = model.conditionPickers[id]
	const picker = stored !== undefined && stored.mode === mode ? stored : Combobox.init(id, mode)
	return {
		...picker,
		selected: row.values,
		inputValue: mode === "single" && !picker.isOpen ? (row.values[0] ?? "") : picker.inputValue,
	}
}

/** The value picker: a suggestion or anything typed (Enter adds it); a single picker closes on a pick. */
export const valuesStep = (
	model: Model,
	queryId: string,
	rowId: string,
	message: Combobox.Message,
	inputs: PanelInputs | undefined,
): Return =>
	withRow(model, queryId, rowId, inputs, ({ model: base, query, rows, row }) => {
		const id = conditionPickerId(queryId, rowId, "values")
		const current = valuePickerOf(base, query, row)
		const isMany = current.mode === "multiple"
		const lift = (next: Combobox.Model): Model => ({
			...base,
			conditionPickers: { ...base.conditionPickers, [id]: next },
		})
		const typed = Str.trim(current.inputValue)
		const isTypedEnter =
			message._tag === "PressedInputKey" &&
			message.key === "Enter" &&
			current.highlighted === null &&
			typed !== ""
		// The grammar cannot spell it; the view says so beside the input.
		if (isTypedEnter && isUnspellable(typed)) return { model: lift(current) }
		if (isTypedEnter && isMany)
			return emitted(
				lift({ ...current, inputValue: "" }),
				query,
				rows,
				replaced(rows, { ...row, values: Arr.dedupe([...row.values, typed]) }),
			)
		const pick = isTypedEnter ? Combobox.Message.PressedEscape() : message
		const next = Combobox.update(isTypedEnter ? { ...current, selected: [typed] } : current, pick)
		const commands = Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotConditionValues({ queryId, rowId, message: inner }),
		)
		const values = isTypedEnter
			? [typed]
			: next.outMessage?._tag === "ChangedSelection"
				? next.outMessage.selected
				: next.outMessage?._tag === "ChangedValue"
					? [next.outMessage.value]
					: null
		if (values === null || Arr.some(values, isUnspellable)) return { model: lift(next.model), commands }
		return emitted(lift(next.model), query, rows, replaced(rows, { ...row, values }), commands)
	})

const isOperator = Schema.is(Operator)

/** The operator select (`whereOp:<query id>:<row id>`); a valueless operator drops the values. */
export const operatorStep = (
	model: Model,
	id: string,
	message: Select.Message,
	inputs: PanelInputs | undefined,
): Return => {
	const current = model.selects[id] ?? Select.init(id, { value: "", selectedIndex: null })
	const next = Select.update(current, message)
	const lifted: Model = { ...model, selects: { ...model.selects, [id]: next.model } }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotSelectMessage({ id, message: inner }),
	)
	const [, queryId = "", rowId = ""] = Str.split(":")(id)
	const operator = next.outMessage?.value
	if (operator === undefined || !isOperator(operator)) return { model: lifted, commands }
	return withRow(lifted, queryId, rowId, inputs, ({ model: base, query, rows, row }) => {
		const values = isValueless(operator)
			? []
			: holdsManyValues({ key: row.key, operator }, query)
				? row.values
				: Arr.take(row.values, 1)
		return emitted(base, query, rows, replaced(rows, { ...row, operator, values }), commands)
	})
}
