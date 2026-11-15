import { COMPARISON_OPS, type Expr, SET_OPS, type ValueType } from "./ast"
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

const expect = (expr: Expr, want: ReadonlyArray<ValueType>, context: string): string | undefined => {
	const inner = checkTypes(expr)
	if (inner !== undefined) return inner
	const got = valueTypeOf(expr)
	return want.includes(got) ? undefined : `expected type ${want.join(" or ")} in ${context}, got ${got}`
}

/** The first type error in the expression, or undefined. Mirrors Prometheus' parser checks. */
export const checkTypes = (expr: Expr): string | undefined => {
	switch (expr.type) {
		case "NumberLiteral":
		case "StringLiteral":
		case "VectorSelector":
		case "MatrixSelector":
			return undefined
		case "Paren":
			return checkTypes(expr.expr)
		case "Unary":
			return expect(expr.expr, ["scalar", "vector"], "unary expression")
		case "Subquery":
			return expect(expr.expr, ["vector"], "subquery")
		case "Aggregate": {
			const inner = expect(expr.expr, ["vector"], `aggregation "${expr.op}"`)
			if (inner !== undefined || expr.param === undefined) return inner
			const wanted = expr.op === "count_values" ? "string" : "scalar"
			return expect(expr.param, [wanted], `aggregation parameter of "${expr.op}"`)
		}
		case "Call": {
			const signature = functionSignature(expr.func)
			if (signature === undefined) return `unknown function "${expr.func}"`
			const { args, optional } = signature
			const min = optional === -1 ? args.length : args.length - optional
			const max = optional === -1 ? Number.POSITIVE_INFINITY : args.length
			if (expr.args.length < min || expr.args.length > max) {
				return `expected ${min === max ? min : `${min} to ${max}`} argument(s) in call to "${expr.func}", got ${expr.args.length}`
			}
			for (const [index, arg] of expr.args.entries()) {
				const want = args[Math.min(index, args.length - 1)] ?? "vector"
				const error = expect(arg, [want], `call to function "${expr.func}"`)
				if (error !== undefined) return error
			}
			return undefined
		}
		case "Binary": {
			const lhsError = expect(expr.lhs, ["scalar", "vector"], "binary expression")
			if (lhsError !== undefined) return lhsError
			const rhsError = expect(expr.rhs, ["scalar", "vector"], "binary expression")
			if (rhsError !== undefined) return rhsError
			const lhs = valueTypeOf(expr.lhs)
			const rhs = valueTypeOf(expr.rhs)
			const isComparison = COMPARISON_OPS.has(expr.op)
			if (expr.returnBool && !isComparison)
				return "bool modifier can only be used on comparison operators"
			if (isComparison && lhs === "scalar" && rhs === "scalar" && !expr.returnBool) {
				return "comparisons between scalars must use BOOL modifier"
			}
			if (SET_OPS.has(expr.op)) {
				if (lhs !== "vector" || rhs !== "vector")
					return `set operator "${expr.op}" not allowed in binary scalar expression`
				if (expr.matching !== undefined && expr.matching.card !== "one-to-one") {
					return "no grouping allowed for set operations"
				}
			}
			if (expr.matching !== undefined && (lhs !== "vector" || rhs !== "vector")) {
				return "vector matching only allowed between instant vectors"
			}
			return undefined
		}
	}
}
