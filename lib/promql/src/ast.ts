/** The PromQL value types an expression can evaluate to. */
export type ValueType = "scalar" | "vector" | "matrix" | "string"

export type MatchOp = "=" | "!=" | "=~" | "!~"

export interface LabelMatcher {
	readonly name: string
	readonly op: MatchOp
	readonly value: string
}

/** `@ <time>`, `@ start()` or `@ end()`. */
export type AtModifier =
	| { readonly kind: "time"; readonly timeMs: number }
	| { readonly kind: "start" }
	| { readonly kind: "end" }

export interface NumberLiteral {
	readonly type: "NumberLiteral"
	readonly value: number
}

export interface StringLiteral {
	readonly type: "StringLiteral"
	readonly value: string
}

/** `name{matchers}`. The metric name, when given, is also a `__name__` matcher in `matchers`. */
export interface VectorSelector {
	readonly type: "VectorSelector"
	readonly name: string | undefined
	readonly matchers: ReadonlyArray<LabelMatcher>
	readonly offsetMs: number
	readonly at: AtModifier | undefined
}

export interface MatrixSelector {
	readonly type: "MatrixSelector"
	readonly vector: VectorSelector
	readonly rangeMs: number
}

export interface SubqueryExpr {
	readonly type: "Subquery"
	readonly expr: Expr
	readonly rangeMs: number
	/** Absent: the query's default evaluation interval. */
	readonly stepMs: number | undefined
	readonly offsetMs: number
	readonly at: AtModifier | undefined
}

export interface Call {
	readonly type: "Call"
	readonly func: string
	readonly args: ReadonlyArray<Expr>
}

export type AggregateOp =
	| "sum"
	| "avg"
	| "min"
	| "max"
	| "count"
	| "group"
	| "stddev"
	| "stdvar"
	| "topk"
	| "bottomk"
	| "quantile"
	| "count_values"
	| "limitk"
	| "limit_ratio"

export interface AggregateExpr {
	readonly type: "Aggregate"
	readonly op: AggregateOp
	readonly expr: Expr
	/** The first argument of topk, bottomk, quantile, count_values, limitk, limit_ratio. */
	readonly param: Expr | undefined
	readonly grouping: ReadonlyArray<string>
	readonly without: boolean
}

export type ArithmeticOp = "+" | "-" | "*" | "/" | "%" | "^" | "atan2"
export type ComparisonOp = "==" | "!=" | ">" | "<" | ">=" | "<="
export type SetOp = "and" | "or" | "unless"
export type BinaryOp = ArithmeticOp | ComparisonOp | SetOp

export type VectorMatchCardinality = "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many"

export interface VectorMatching {
	readonly card: VectorMatchCardinality
	/** true: `on(labels)`; false: `ignoring(labels)` (or no clause, an empty ignoring). */
	readonly on: boolean
	readonly labels: ReadonlyArray<string>
	/** The labels of `group_left(...)` / `group_right(...)`. */
	readonly include: ReadonlyArray<string>
}

export interface BinaryExpr {
	readonly type: "Binary"
	readonly op: BinaryOp
	readonly lhs: Expr
	readonly rhs: Expr
	readonly returnBool: boolean
	/** Set when both sides are vectors. */
	readonly matching: VectorMatching | undefined
}

export interface UnaryExpr {
	readonly type: "Unary"
	readonly op: "-" | "+"
	readonly expr: Expr
}

export interface ParenExpr {
	readonly type: "Paren"
	readonly expr: Expr
}

export type Expr =
	| NumberLiteral
	| StringLiteral
	| VectorSelector
	| MatrixSelector
	| SubqueryExpr
	| Call
	| AggregateExpr
	| BinaryExpr
	| UnaryExpr
	| ParenExpr

export const COMPARISON_OPS: ReadonlySet<string> = new Set(["==", "!=", ">", "<", ">=", "<="])
export const SET_OPS: ReadonlySet<string> = new Set(["and", "or", "unless"])

/** Aggregations that take a parameter before the vector. */
export const PARAM_AGGREGATES: ReadonlySet<AggregateOp> = new Set([
	"topk",
	"bottomk",
	"quantile",
	"count_values",
	"limitk",
	"limit_ratio",
])
