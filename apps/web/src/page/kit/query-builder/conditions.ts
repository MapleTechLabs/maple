import { Operator } from "@maple/domain/where-clause"
import { Command, type Update } from "foldkit"
import * as Combobox from "@maple/views/ui/combobox"
import * as Select from "@maple/views/ui/select"
import type { Resources } from "../../../platform/resources"
import { QueryChange } from "./change"
import { canMatchAnyOf, fieldOf, fieldPickerItems, fieldsOf, operatorsOf } from "./condition-fields"
import {
	type ConditionRow,
	isValueless,
	nextRowId,
	parseConditionRows,
	printConditionRows,
	isAnyOf,
	isNoneOf,
} from "./condition-rows"
import type { QueryDraft } from "./draft"
import { Message, type Model, OutMessage, type WhereMode } from "./panel-message"
import type { PanelInputs } from "./where"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

// The condition builder's steps: every edit prints the rows and leaves as the query's
// where-clause edit, so previews and saving see only the string.

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

export type PickerPart = "field" | "values"

export const conditionPickerId = (queryId: string, rowId: string, part: PickerPart): string =>
	`cond-${queryId}-${rowId}-${part}`

const OPERATOR_SELECT = "whereOp"

export const operatorSelectId = (queryId: string, rowId: string): string =>
	`${OPERATOR_SELECT}:${queryId}:${rowId}`

export const isOperatorSelect = (id: string): boolean => Str.startsWith(`${OPERATOR_SELECT}:`)(id)

/** The rows a query shows: the kept ones while they still print its where clause, else a fresh parse. */
export const conditionRowsOf = (
	model: Model,
	query: QueryDraft,
): Option.Option<ReadonlyArray<ConditionRow>> => {
	const kept = model.conditions[query.id]
	return kept !== undefined && printConditionRows(kept) === query.whereClause
		? Option.some(kept)
		: parseConditionRows(query.whereClause)
}

/** Whether a query edits as rows: chosen (the default) and representable. */
export const whereModeOf = (model: Model, query: QueryDraft): WhereMode =>
	model.whereModes[query.id] ?? "builder"

const emitted = (
	model: Model,
	query: QueryDraft,
	rows: ReadonlyArray<ConditionRow>,
	commands?: Return["commands"],
): Return => ({
	model: { ...model, conditions: { ...model.conditions, [query.id]: rows } },
	...(commands === undefined ? undefined : { commands }),
	outMessage: OutMessage.ChangedQuery({
		queryId: query.id,
		change: QueryChange.SetText({ field: "whereClause", value: printConditionRows(rows) }),
	}),
})

type RowContext = Readonly<{ query: QueryDraft; rows: ReadonlyArray<ConditionRow> }>

const withRows = (
	model: Model,
	queryId: string,
	inputs: PanelInputs | undefined,
	step: (context: RowContext) => Return,
): Return => {
	const query = inputs?.queryOf(queryId)
	if (query === undefined) return { model }
	return Option.match(conditionRowsOf(model, query), {
		onNone: () => ({ model }),
		onSome: (rows) => step({ query, rows }),
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
			{ onNone: () => ({ model }), onSome: (row) => step({ ...context, row }) },
		),
	)

const replaced = (rows: ReadonlyArray<ConditionRow>, next: ConditionRow): ReadonlyArray<ConditionRow> =>
	Arr.map(rows, (row) => (row.id === next.id ? next : row))

export const changedWhereMode = (model: Model, queryId: string, mode: WhereMode): Return => ({
	model: {
		...model,
		whereModes: { ...model.whereModes, [queryId]: mode },
		conditions: Rec.remove(model.conditions, queryId),
	},
})

/** A new row opens its field picker, as the first thing to choose. */
export const addedCondition = (model: Model, queryId: string, inputs: PanelInputs | undefined): Return =>
	withRows(model, queryId, inputs, ({ query, rows }) => {
		const id = nextRowId(rows)
		const pickerId = conditionPickerId(queryId, id, "field")
		const opened: Model = {
			...model,
			conditionPickers: {
				...model.conditionPickers,
				[pickerId]: Combobox.init(pickerId, "single", { isOpen: true }),
			},
		}
		return emitted(opened, query, [...rows, { id, key: "", operator: "=", values: [] }])
	})

export const removedCondition = (
	model: Model,
	queryId: string,
	rowId: string,
	inputs: PanelInputs | undefined,
): Return =>
	withRows(model, queryId, inputs, ({ query, rows }) => {
		const pickerIds = [
			conditionPickerId(queryId, rowId, "field"),
			conditionPickerId(queryId, rowId, "values"),
		]
		const pickers = Rec.filter(model.conditionPickers, (_, id) => !pickerIds.includes(id))
		return emitted(
			{
				...model,
				conditionPickers: pickers,
				selects: Rec.remove(model.selects, operatorSelectId(queryId, rowId)),
			},
			query,
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

const pickerOf = (model: Model, id: string, mode: Combobox.Mode): Combobox.Model =>
	model.conditionPickers[id] ?? Combobox.init(id, mode)

/** The field picker: a group or "All fields" drills without closing; a field sets the row's key. */
export const fieldStep = (
	model: Model,
	queryId: string,
	rowId: string,
	message: Combobox.Message,
	inputs: PanelInputs | undefined,
): Return =>
	withRow(model, queryId, rowId, inputs, ({ query, rows, row }) => {
		const id = conditionPickerId(queryId, rowId, "field")
		const current = { ...pickerOf(model, id, "single"), selected: row.key === "" ? [] : [row.key] }
		const drill = model.fieldDrills[id] ?? "all"
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
					...model,
					conditionPickers: {
						...model.conditionPickers,
						[id]: { ...current, inputValue: "", highlighted: 0 },
					},
					fieldDrills: { ...model.fieldDrills, [id]: navigated.value },
				},
			}
		const next = Combobox.update(current, message)
		const lifted: Model = {
			...model,
			conditionPickers: { ...model.conditionPickers, [id]: next.model },
			fieldDrills: next.model.isOpen ? model.fieldDrills : Rec.remove(model.fieldDrills, id),
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
		const operators = operatorsOf(fieldOf(key, query.dataSource).kind)
		const operator = operators.includes(row.operator) ? row.operator : "="
		return emitted(lifted, query, replaced(rows, { ...row, key, operator, values: [] }), commands)
	})

/** Whether a row holds several values: "is not" always (AND-ed excludes), "is" only where the engine ORs. */
export const holdsManyValues = (row: Pick<ConditionRow, "key" | "operator">, query: QueryDraft): boolean =>
	isNoneOf(row.operator) ||
	(isAnyOf(row.operator) && canMatchAnyOf(fieldOf(row.key, query.dataSource), query.dataSource))

const withValue = (row: ConditionRow, query: QueryDraft, value: string): ReadonlyArray<string> =>
	holdsManyValues(row, query) ? Arr.dedupe([...row.values, value]) : [value]

/** The value picker: suggestions or anything typed (Enter adds it); one value unless the row holds many. */
export const valuesStep = (
	model: Model,
	queryId: string,
	rowId: string,
	message: Combobox.Message,
	inputs: PanelInputs | undefined,
): Return =>
	withRow(model, queryId, rowId, inputs, ({ query, rows, row }) => {
		const id = conditionPickerId(queryId, rowId, "values")
		const current = { ...pickerOf(model, id, "multiple"), selected: row.values }
		const typed = Str.trim(current.inputValue)
		if (
			message._tag === "PressedInputKey" &&
			message.key === "Enter" &&
			current.highlighted === null &&
			typed !== ""
		)
			return emitted(
				{
					...model,
					conditionPickers: { ...model.conditionPickers, [id]: { ...current, inputValue: "" } },
				},
				query,
				replaced(rows, { ...row, values: withValue(row, query, typed) }),
			)
		const next = Combobox.update(current, message)
		const lifted: Model = { ...model, conditionPickers: { ...model.conditionPickers, [id]: next.model } }
		const commands = Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotConditionValues({ queryId, rowId, message: inner }),
		)
		if (next.outMessage?._tag !== "ChangedSelection") return { model: lifted, commands }
		const selected = next.outMessage.selected
		const values = holdsManyValues(row, query) ? selected : Arr.takeRight(selected, 1)
		return emitted(lifted, query, replaced(rows, { ...row, values }), commands)
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
	return withRow(lifted, queryId, rowId, inputs, ({ query, rows, row }) => {
		const values = isValueless(operator)
			? []
			: holdsManyValues({ key: row.key, operator }, query)
				? row.values
				: Arr.take(row.values, 1)
		return emitted(lifted, query, replaced(rows, { ...row, operator, values }), commands)
	})
}
