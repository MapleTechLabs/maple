import { COMPARISON_OPS, type Expr, PARAM_AGGREGATES, SET_OPS, type ValueType } from "./ast"
import { functionSignature } from "./functions"

/** The value type an expression evaluates to. Assumes the expression type-checks. */
export const valueTypeOf = (expr: Expr): ValueType => {
	switch (expr.type) {
		case "NumberLiteral":
			return "scalar"
		case "StringLiteral":
			return "string"
		case "VectorSelector":
		case "Aggregate":
			return "vector"
		case "MatrixSelector":
		case "Subquery":
			return "matrix"
		case "Call":
			return functionSignature(expr.func)?.returns ?? "vector"
		case "Paren":
		case "Unary":
			return valueTypeOf(expr.expr)
		case "Binary":
			return valueTypeOf(expr.lhs) === "scalar" && valueTypeOf(expr.rhs) === "scalar"
				? "scalar"
				: "vector"
	}
}

/** Prometheus' DocumentedType: the names its error messages use. */
const documented = (type: ValueType): string =>
	type === "matrix" ? "range vector" : type === "vector" ? "instant vector" : type

/** A type error and the expression it is about, so the parser can point at it. */
export interface PromqlTypeError {
	readonly message: string
	readonly at: Expr
}

const expect = (expr: Expr, want: ReadonlyArray<ValueType>, context: string): PromqlTypeError | undefined => {
	const inner = checkTypes(expr)
	if (inner !== undefined) return inner
	const got = valueTypeOf(expr)
	return want.includes(got)
		? undefined
		: { message: `expected type ${want.join(" or ")} in ${context}, got ${got}`, at: expr }
}

/** The first type error in the expression, or undefined. Mirrors Prometheus' parser checks. */
export const checkTypes = (expr: Expr): PromqlTypeError | undefined => {
	const error = (message: string): PromqlTypeError => ({ message, at: expr })
	switch (expr.type) {
		case "NumberLiteral":
		case "StringLiteral":
		case "VectorSelector":
		case "MatrixSelector":
			return undefined
		case "Paren":
			return checkTypes(expr.expr)
		case "Unary": {
			const inner = checkTypes(expr.expr)
			if (inner !== undefined) return inner
			const got = valueTypeOf(expr.expr)
			return got === "scalar" || got === "vector"
				? undefined
				: error(
						`unary expression only allowed on expressions of type scalar or instant vector, got ${JSON.stringify(documented(got))}`,
					)
		}
		case "Subquery": {
			const inner = checkTypes(expr.expr)
			if (inner !== undefined) return inner
			const got = valueTypeOf(expr.expr)
			return got === "vector"
				? undefined
				: { message: `subquery is only allowed on instant vector, got ${got} instead`, at: expr.expr }
		}
		case "Aggregate": {
			const expected = PARAM_AGGREGATES.has(expr.op) ? 2 : 1
			const got = expr.param === undefined ? 1 : 2
			if (got !== expected)
				return error(
					`wrong number of arguments for aggregate expression provided, expected ${expected}, got ${got}`,
				)
			const inner = expect(expr.expr, ["vector"], `aggregation "${expr.op}"`)
			if (inner !== undefined || expr.param === undefined) return inner
			const wanted = expr.op === "count_values" ? "string" : "scalar"
			return expect(expr.param, [wanted], `aggregation parameter of "${expr.op}"`)
		}
		case "Call": {
			const signature = functionSignature(expr.func)
			if (signature === undefined) return error(`unknown function "${expr.func}"`)
			const { args, optional } = signature
			// A variadic last argument may appear zero times.
			const min = optional === -1 ? args.length - 1 : args.length - optional
			const max = optional === -1 ? Number.POSITIVE_INFINITY : args.length
			if (expr.args.length < min || expr.args.length > max) {
				const expected =
					optional === -1 ? `at least ${min}` : min === max ? `${min}` : `${min} to ${max}`
				return error(
					`expected ${expected} argument(s) in call to "${expr.func}", got ${expr.args.length}`,
				)
			}
			for (const [index, arg] of expr.args.entries()) {
				const want = args[Math.min(index, args.length - 1)] ?? "vector"
				const argError = expect(arg, [want], `call to function "${expr.func}"`)
				if (argError !== undefined) return argError
			}
			return undefined
		}
		case "Binary": {
			const operandError = checkTypes(expr.lhs) ?? checkTypes(expr.rhs)
			if (operandError !== undefined) return operandError
			const lhs = valueTypeOf(expr.lhs)
			const rhs = valueTypeOf(expr.rhs)
			const mixed = "binary expression must contain only scalar and instant vector types"
			if (lhs !== "scalar" && lhs !== "vector") return { message: mixed, at: expr.lhs }
			if (rhs !== "scalar" && rhs !== "vector") return { message: mixed, at: expr.rhs }
			const isComparison = COMPARISON_OPS.has(expr.op)
			if (expr.returnBool && !isComparison)
				return error("bool modifier can only be used on comparison operators")
			if (isComparison && lhs === "scalar" && rhs === "scalar" && !expr.returnBool) {
				return error("comparisons between scalars must use BOOL modifier")
			}
			if (expr.matching?.on === true) {
				const { labels, include } = expr.matching
				const both = include.find((label) => labels.includes(label))
				if (both !== undefined)
					return error(
						`label ${JSON.stringify(both)} must not occur in ON and GROUP clause at once`,
					)
			}
			if (SET_OPS.has(expr.op)) {
				if (lhs !== "vector" || rhs !== "vector")
					return error(`set operator "${expr.op}" not allowed in binary scalar expression`)
				if (expr.matching !== undefined && expr.matching.card !== "one-to-one") {
					return error("no grouping allowed for set operations")
				}
			}
			const scalarSide = lhs !== "vector" || rhs !== "vector"
			if (expr.matching !== undefined && expr.matching.labels.length > 0 && scalarSide) {
				return error("vector matching only allowed between instant vectors")
			}
			return undefined
		}
	}
}
