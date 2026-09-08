import type { Expr, Condition } from "./expr"
import type { CompiledQuery } from "./compile"
import type { SqlFragment } from "../sql/sql-fragment"

/** Internal evidence, kept off the public expression/condition API. */
export type TenantPredicate =
	| { readonly column: string; readonly value: SqlFragment }
	| { readonly left: string; readonly right: string }

const columns = new WeakMap<Expr<unknown>, string>()
const predicates = new WeakMap<Condition, ReadonlyArray<TenantPredicate>>()

export const tenantColumnOf = (expr: Expr<unknown>): string | undefined => columns.get(expr)
export const markTenantColumn = (expr: Expr<unknown>, column: string): void => {
	columns.set(expr, column)
}
export const tenantPredicatesOf = (condition: Condition): ReadonlyArray<TenantPredicate> =>
	predicates.get(condition) ?? []
export const markTenantPredicate = <A extends Condition>(
	condition: A,
	evidence: ReadonlyArray<TenantPredicate>,
): A => {
	predicates.set(condition, evidence)
	return condition
}

/** The bound behind an inherited scope; absent only for caller-asserted SQL. */
type ScopedQuery = Pick<CompiledQuery<unknown>, "sql" | "tenantScope">
const bounds = new WeakMap<ScopedQuery, string>()
export const tenantBoundOf = (query: ScopedQuery): string | undefined => bounds.get(query)
export const withTenantBound = <A extends ScopedQuery>(query: A, bound: string | undefined): A => {
	if (bound !== undefined) bounds.set(query, bound)
	return query
}
