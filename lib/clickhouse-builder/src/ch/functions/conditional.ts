import { makeExpr, toFragment } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import { Schema } from "effect"
import { compileTypedFnCall, defineFn, firstTypedNonNull, numericResultSchema, schemaOf } from "../define-fn"

// if / multiIf (handwritten — standard fn shape but special arg types)

/** Either branch can produce the result, including a nullable branch. */
export const if_ = <T>(cond: Condition, then_: Expr<T>, else_: Expr<T>): Expr<T> =>
	defineFn<[Condition, Expr<T>, Expr<T>], T>("if", (_, then_, else_) => branchSchema(then_, else_))(
		cond,
		then_,
		else_,
	)

export function multiIf<T>(cases: Array<[Condition, Expr<T>]>, else_: Expr<T>): Expr<T> {
	const parts = cases
		.map(([cond, val]) => `${compile(cond.toFragment())}, ${compile(val.toFragment())}`)
		.join(", ")
	return makeExpr(
		raw(`multiIf(${parts}, ${compile(else_.toFragment())})`),
		branchSchema<T>(...cases.map(([, value]) => value), else_),
	)
}

// Variadic conditional functions

/** The first argument that is not NULL — non-nullable as soon as one argument
 *  is, which is what {@link firstTypedNonNull} reads off the arguments. */
type ExprValue<E> = E extends Expr<any> ? Exclude<E["_phantom"], undefined> : never
type Coalesced<Args extends readonly Expr<any>[]> = Args extends readonly [
	...Expr<any>[],
	infer Last extends Expr<any>,
]
	? null extends ExprValue<Last>
		? ExprValue<Args[number]>
		: NonNullable<ExprValue<Args[number]>>
	: number extends Args["length"]
		? ExprValue<Args[number]>
		: Args extends readonly [infer Head extends Expr<any>, ...infer Tail extends Expr<any>[]]
			? null extends ExprValue<Head>
				? Exclude<ExprValue<Head>, null> | Coalesced<Tail>
				: ExprValue<Head>
			: null

export const coalesce = <const Args extends Expr<any>[]>(...exprs: Args): Expr<Coalesced<Args>> =>
	defineFn<Args, Coalesced<Args>>("coalesce", firstTypedNonNull())(...exprs)

/**
 * `ifNull(expr, fallback)` — `expr` unless it is NULL, else `fallback`. The
 * two-argument coalesce; a non-nullable fallback strips the `| null`.
 */
export const ifNull = <T>(expr: Expr<T | null>, fallback: Expr<T>): Expr<T> =>
	defineFn<[Expr<T | null>, Expr<T>], T>("ifNull", firstTypedNonNull())(expr, fallback)

export function nullIf<T>(expr: Expr<T>, value: Expr<T> | T): Expr<T | null> {
	// The result is `expr` or NULL, so it decodes as `expr` does — nullably.
	const schema = schemaOf<T>(expr)
	return compileTypedFnCall<T | null>("nullIf", schema && Schema.NullOr(schema), expr, value)
}

/**
 * `ifNotFinite(expr, fallback)` — `expr` unless it is `nan`/`inf`, else
 * `fallback`.
 *
 * SQL NULL passes through unchanged. For a guaranteed numeric result use
 * `ifNull(ifNotFinite(expr, 0), lit(0))`.
 */
export function ifNotFinite<N extends number | null>(
	expr: Expr<N>,
	fallback: number | Expr<number>,
): Expr<number | Extract<N, null>> {
	return makeExpr<number | Extract<N, null>>(
		raw(`ifNotFinite(${compile(expr.toFragment())}, ${compile(toFragment(fallback))})`),
		numericResultSchema(expr),
	)
}

function branchSchema<T>(...exprs: Expr<T>[]): Schema.Codec<T, any> | undefined {
	const schemas: Schema.Codec<T, any>[] = []
	for (const expr of exprs) {
		if (!expr.schema) return undefined
		if (!schemas.includes(expr.schema)) schemas.push(expr.schema)
	}
	return schemas.length === 1 ? schemas[0] : Schema.Union(schemas)
}
