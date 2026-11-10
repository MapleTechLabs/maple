import {
	normalizeKey,
	Operator,
	type ParsedClause,
	parseWhereClause,
	quoteWhereValue,
	splitWhereClause,
} from "@maple/domain/where-clause"
import { type QueryBuilderDataSource, whereKeyMatchesAnyOf } from "@maple/query-engine/query-builder"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"

// The condition builder's rows and their two-way mapping to the where-clause string
// (`@maple/domain/where-clause`): rows are AND-ed; a row's values are OR-ed for `=`/`contains`
// and AND-ed for `!=`/`!contains`. Reading is per data source: what one source ORs another drops.

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

/**
 * Why a clause has no rows: an OR across fields, an OR a row's operators can't hold, an OR on a
 * key the source does not OR, or other syntax.
 */
export type UnshowableReason = "mixedFields" | "orOperators" | "orNotApplied" | "syntax"

type Part = Result.Result<Draft, UnshowableReason>

/**
 * A bare value that is the rest of a mistyped operator: `key ==` reads as `key = "="` and
 * `key >=` as `key > "="`. Quoted (`key = "="`), the same value is one the user meant.
 */
const looksLikeOperator = (value: string): boolean => /^=|^[=!<>]+$/.test(value)

const timesIn = (text: string, needle: string): number => Str.split(needle)(text).length - 1

/** Each clause with such a value needs its own quoted spelling in `part`: a sibling's does not vouch for it. */
const hasStrayOperator = (clauses: ReadonlyArray<ParsedClause>, part: string): boolean =>
	Arr.some(Arr.dedupe(Arr.map(clauses, (clause) => clause.value)), (value) => {
		if (!looksLikeOperator(value)) return false
		const quoted = timesIn(part, `"${value}"`) + timesIn(part, `'${value}'`)
		return Arr.filter(clauses, (clause) => clause.value === value).length > quoted
	})

/**
 * One AND-ed part: a single clause, or an OR group whose members share key and an any-of
 * operator, on a key the source ORs (the engine's `whereKeyMatchesAnyOf`).
 */
const readPart = (part: string, dataSource: QueryBuilderDataSource): Part => {
	const parsed = parseWhereClause(part, { orGroups: true })
	if (parsed.warnings.length > 0) return Result.fail("syntax")
	const clauses = [...parsed.clauses, ...Arr.flatten(parsed.groups)]
	if (hasStrayOperator(clauses, part)) return Result.fail("syntax")
	const [clause] = parsed.clauses
	if (parsed.groups.length === 0 && parsed.clauses.length === 1 && clause !== undefined)
		return Result.succeed(draftOf(clause))
	const [group] = parsed.groups
	if (parsed.clauses.length > 0 || parsed.groups.length !== 1 || group === undefined)
		return Result.fail("syntax")
	const drafts = Arr.map(group, draftOf)
	const [first] = drafts
	if (first === undefined) return Result.fail("syntax")
	if (!Arr.every(drafts, (draft) => draft.key === first.key)) return Result.fail("mixedFields")
	if (!isAnyOf(first.operator) || !Arr.every(drafts, (draft) => draft.operator === first.operator))
		return Result.fail("orOperators")
	// Such a row holds one value: shown as a row, the next pick would drop the rest of a saved group.
	if (drafts.length > 1 && !whereKeyMatchesAnyOf(dataSource, first.key)) return Result.fail("orNotApplied")
	return Result.succeed({ ...first, values: Arr.flatMap(drafts, (draft) => draft.values) })
}

/** Why the builder can't show a clause on this source, or none when it reads as rows. */
export const unshowableReasonOf = (
	whereClause: string,
	dataSource: QueryBuilderDataSource,
): Option.Option<UnshowableReason> =>
	Arr.findFirst(splitWhereClause(Str.trim(whereClause)), (part) =>
		Result.getFailure(readPart(part, dataSource)),
	)

/** A row with the clause text it was read from, so an untouched row keeps the user's spelling. */
type Spelled = Readonly<{ draft: Draft; text: string }>

/** `k != a AND k != b` reads as one "is not a, b" row. */
const mergeNoneOf = (parts: ReadonlyArray<Spelled>): ReadonlyArray<Spelled> =>
	Arr.reduce(parts, Arr.empty<Spelled>(), (rows: ReadonlyArray<Spelled>, part) => {
		if (!isNoneOf(part.draft.operator)) return [...rows, part]
		const index = Arr.findFirstIndex(
			rows,
			(row) => row.draft.key === part.draft.key && row.draft.operator === part.draft.operator,
		)
		return Option.match(index, {
			onNone: () => [...rows, part],
			onSome: (at) =>
				Arr.map(rows, (row, i) =>
					i === at
						? {
								draft: {
									...row.draft,
									values: Arr.dedupe([...row.draft.values, ...part.draft.values]),
								},
								text: `${row.text} AND ${part.text}`,
							}
						: row,
				),
		})
	})

const spelledRows = (
	whereClause: string,
	dataSource: QueryBuilderDataSource,
): Option.Option<ReadonlyArray<Spelled>> =>
	Option.map(
		Option.all(
			Arr.map(splitWhereClause(Str.trim(whereClause)), (text) =>
				Option.map(Result.getSuccess(readPart(text, dataSource)), (draft): Spelled => ({
					draft,
					text,
				})),
			),
		),
		mergeNoneOf,
	)

/** The rows a where clause reads as on this source, or none when a row cannot show it. */
export const parseConditionRows = (
	whereClause: string,
	dataSource: QueryBuilderDataSource,
): Option.Option<ReadonlyArray<ConditionRow>> =>
	Option.map(spelledRows(whereClause, dataSource), (parts) =>
		Arr.map(parts, ({ draft }, index) => ({ id: `c${index}`, ...draft })),
	)

const sameDraft = (a: Draft, b: Draft): boolean =>
	a.key === b.key &&
	a.operator === b.operator &&
	a.values.length === b.values.length &&
	Arr.every(a.values, (value, index) => b.values[index] === value)

/** The same complete conditions in the same order, ids aside. */
export const sameConditions = (a: ReadonlyArray<ConditionRow>, b: ReadonlyArray<ConditionRow>): boolean => {
	const left = Arr.filter(a, isComplete)
	const right = Arr.filter(b, isComplete)
	return (
		left.length === right.length &&
		Arr.every(left, (row, index) => {
			const other = right[index]
			return other !== undefined && sameDraft(row, other)
		})
	)
}

/** A value the grammar cannot spell: it has no escape, so a value may not hold both quotes. */
export const isUnspellable = (value: string): boolean => Str.includes('"')(value) && Str.includes("'")(value)

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

/**
 * `printConditionRows`, but a row `original` already holds keeps its text there, so an edit
 * rewrites only the clauses it changed.
 */
export const printConditionRowsOver = (
	rows: ReadonlyArray<ConditionRow>,
	original: string,
	dataSource: QueryBuilderDataSource,
): string => {
	const spelled = Option.getOrElse(spelledRows(original, dataSource), () => Arr.empty<Spelled>())
	const [, texts] = Arr.mapAccum(
		Arr.filter(rows, isComplete),
		spelled,
		(unused: ReadonlyArray<Spelled>, row): [ReadonlyArray<Spelled>, string] =>
			Option.match(
				Arr.findFirstIndex(unused, (part) => sameDraft(part.draft, row)),
				{
					onNone: () => [unused, printRow(row)],
					onSome: (at) => [Arr.remove(unused, at), unused[at]?.text ?? printRow(row)],
				},
			),
	)
	return Arr.join(texts, " AND ")
}

/** A new row's id, past every id the rows use. */
export const nextRowId = (rows: ReadonlyArray<ConditionRow>): string => {
	const used = Arr.map(rows, (row) => Number(Str.slice(1)(row.id)))
	return `c${Arr.reduce(used, -1, (max, id) => (Number.isFinite(id) && id > max ? id : max)) + 1}`
}
