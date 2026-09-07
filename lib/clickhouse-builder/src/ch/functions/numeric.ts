import { compileTypedFnCall, defineFn, numericResultSchema, firstTypedNonNull } from "../define-fn"
import type { Expr } from "../expr"
import * as T from "../types"

// Type conversion (defineFn one-liners)

export const toFloat64OrZero = defineFn<[Expr<string>], number>("toFloat64OrZero", T.float64)
export const toFloat64 = <N extends number | null>(expr: Expr<N>): Expr<number | Extract<N, null>> =>
	compileTypedFnCall("toFloat64", numericResultSchema(expr), expr)
export const toUInt16OrZero = defineFn<[Expr<string>], number>("toUInt16OrZero", T.uint16)
export const toUInt64 = defineFn<[Expr<number> | Expr<string>], number>("toUInt64", T.uint64)
export const toInt64 = <N extends number | null>(expr: Expr<N>): Expr<number | Extract<N, null>> =>
	compileTypedFnCall("toInt64", numericResultSchema(expr), expr)

// Arithmetic (compileFnCall wrappers for mixed arg types)

export function intDiv(a: Expr<number>, b: number | Expr<number>): Expr<number> {
	return compileTypedFnCall<number>("intDiv", T.int64.schema, a, b)
}

export function round_<T extends number | null>(
	expr: Expr<T>,
	decimals?: number,
): Expr<number | Extract<T, null>> {
	return decimals != null
		? compileTypedFnCall("round", numericResultSchema(expr), expr, decimals)
		: compileTypedFnCall("round", numericResultSchema(expr), expr)
}

// Variadic numeric functions

type Extremum<Args extends Expr<number | null>[]> =
	Extract<Args[number], Expr<number>> extends never ? number | null : number

export function least_<const Args extends Expr<number | null>[]>(...exprs: Args): Expr<Extremum<Args>> {
	return defineFn<Args, Extremum<Args>>("least", firstTypedNonNull())(...exprs)
}

export function greatest_<const Args extends Expr<number | null>[]>(...exprs: Args): Expr<Extremum<Args>> {
	return defineFn<Args, Extremum<Args>>("greatest", firstTypedNonNull())(...exprs)
}

export function cityHash64(...exprs: Expr<any>[]): Expr<number> {
	return compileTypedFnCall<number>("cityHash64", T.uint64.schema, ...exprs)
}
