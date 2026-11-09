import {
	normalizeKey,
	Operator,
	type ParsedClause,
	parseWhereClause,
	quoteWhereValue,
	splitWhereClause,
} from "@maple/domain/where-clause"
import { Array as Arr, Option, Schema, String as Str } from "effect"

// The condition builder's rows and their two-way mapping to the where-clause string
// (`@maple/domain/where-clause`): rows are AND-ed; a row's values are OR-ed for `=`/`contains`
// and AND-ed for `!=`/`!contains`.

/** One `[field] [operator] [values]` row; `key` is empty until a field is picked. */
export const ConditionRow = Schema.Struct({
	id: Schema.String,
	key: Schema.String,
	operator: Operator,
	values: Schema.Array(Schema.String),
})
export type ConditionRow = typeof ConditionRow.Type

/** Several values mean "any of them": printed as one `(k = a OR k = b)` group. */
export const isAnyOf = (operator: Operator): boolean => operator === "=" || operator === "contains"

/** Several values mean "none of them": printed as AND-ed clauses. */
export const isNoneOf = (operator: Operator): boolean => operator === "!=" || operator === "!contains"

export const isValueless = (operator: Operator): boolean => operator === "exists" || operator === "!exists"

/** An alias (`service`) as its canonical key; any other key as typed, since attribute keys keep case. */
const keyOf = (clause: ParsedClause): string => {
	const canonical = normalizeKey(clause.key)
	return canonical !== clause.key ? canonical : (clause.rawKey ?? clause.key)
}

type Draft = Omit<ConditionRow, "id">

const draftOf = (clause: ParsedClause): Draft => ({
	key: keyOf(clause),
	operator: clause.operator,
	values: isValueless(clause.operator) ? [] : [clause.value],
})

/** One AND-ed part: a single clause, or an OR group whose members share key and an any-of operator. */
const partOf = (part: string): Option.Option<Draft> => {
	const parsed = parseWhereClause(part, { orGroups: true })
	if (parsed.warnings.length > 0) return Option.none()
	const [clause] = parsed.clauses
	if (parsed.groups.length === 0 && parsed.clauses.length === 1 && clause !== undefined)
		return Option.some(draftOf(clause))
	const [group] = parsed.groups
	if (parsed.clauses.length > 0 || parsed.groups.length !== 1 || group === undefined) return Option.none()
	const drafts = Arr.map(group, draftOf)
	const [first] = drafts
	if (first === undefined || !isAnyOf(first.operator)) return Option.none()
	const isShared = Arr.every(
		drafts,
		(draft) => draft.key === first.key && draft.operator === first.operator,
	)
	return isShared
		? Option.some({ ...first, values: Arr.flatMap(drafts, (draft) => draft.values) })
		: Option.none()
}

/** `k != a AND k != b` reads as one "is not a, b" row. */
const mergeNoneOf = (drafts: ReadonlyArray<Draft>): ReadonlyArray<Draft> =>
	Arr.reduce(drafts, Arr.empty<Draft>(), (rows: ReadonlyArray<Draft>, draft) => {
		if (!isNoneOf(draft.operator)) return [...rows, draft]
		const index = Arr.findFirstIndex(
			rows,
			(row) => row.key === draft.key && row.operator === draft.operator,
		)
		return Option.match(index, {
			onNone: () => [...rows, draft],
			onSome: (at) =>
				Arr.map(rows, (row, i) =>
					i === at ? { ...row, values: Arr.dedupe([...row.values, ...draft.values]) } : row,
				),
		})
	})

/** The rows a where clause reads as, or none when it uses syntax a row cannot show. */
export const parseConditionRows = (whereClause: string): Option.Option<ReadonlyArray<ConditionRow>> =>
	Option.map(Option.all(Arr.map(splitWhereClause(Str.trim(whereClause)), partOf)), (drafts) =>
		Arr.map(mergeNoneOf(drafts), (draft, index) => ({ id: `c${index}`, ...draft })),
	)

/** Numbers and booleans stay bare (`root_only = true` is what the span select reads); the rest is quoted. */
const literalOf = (value: string): string =>
	/^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false" ? value : quoteWhereValue(value)

const clauseOf = (key: string, operator: Operator, value: string): string =>
	isValueless(operator) ? `${key} ${operator}` : `${key} ${operator} ${literalOf(value)}`

/** A row the where clause can carry: a field, and a value unless the operator takes none. */
export const isComplete = (row: ConditionRow): boolean =>
	row.key !== "" && (isValueless(row.operator) || row.values.length > 0)

const printRow = (row: ConditionRow): string => {
	if (isValueless(row.operator)) return clauseOf(row.key, row.operator, "")
	const clauses = Arr.map(row.values, (value) => clauseOf(row.key, row.operator, value))
	if (clauses.length === 1) return Arr.join(clauses, "")
	return isAnyOf(row.operator) ? `(${Arr.join(clauses, " OR ")})` : Arr.join(clauses, " AND ")
}

/** The where clause for the complete rows; an unfinished row prints nothing. */
export const printConditionRows = (rows: ReadonlyArray<ConditionRow>): string =>
	Arr.join(Arr.map(Arr.filter(rows, isComplete), printRow), " AND ")

/** A new row's id, past every id the rows use. */
export const nextRowId = (rows: ReadonlyArray<ConditionRow>): string => {
	const used = Arr.map(rows, (row) => Number(Str.slice(1)(row.id)))
	return `c${Arr.reduce(used, -1, (max, id) => (Number.isFinite(id) && id > max ? id : max)) + 1}`
}
