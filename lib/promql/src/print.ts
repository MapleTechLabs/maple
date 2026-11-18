import type { AtModifier, Expr, LabelMatcher, VectorSelector } from "./ast"
import { formatDuration } from "./literals"
import { FUNCTIONS } from "./functions"
import { lookup } from "./lookup"

const IDENTIFIER = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Names that would read as a keyword, number or function if printed bare: keep them quoted. */
const RESERVED: ReadonlySet<string> = new Set([
	...Object.keys(FUNCTIONS),
	"and",
	"or",
	"unless",
	"atan2",
	"bool",
	"by",
	"without",
	"on",
	"ignoring",
	"group_left",
	"group_right",
	"offset",
	"start",
	"end",
	"inf",
	"nan",
	"sum",
	"avg",
	"min",
	"max",
	"count",
	"group",
	"stddev",
	"stdvar",
	"topk",
	"bottomk",
	"quantile",
	"count_values",
	"limitk",
	"limit_ratio",
])

const quote = (value: string): string => JSON.stringify(value)

const labelName = (name: string): string => (LABEL_NAME.test(name) ? name : quote(name))

const number = (value: number): string => {
	if (Number.isNaN(value)) return "NaN"
	if (value === Number.POSITIVE_INFINITY) return "Inf"
	if (value === Number.NEGATIVE_INFINITY) return "-Inf"
	return Object.is(value, -0) ? "-0" : String(value)
}

const modifiers = (offsetMs: number, at: AtModifier | undefined): string => {
	let out = ""
	if (at !== undefined) {
		out +=
			at.kind === "start"
				? " @ start()"
				: at.kind === "end"
					? " @ end()"
					: ` @ ${number(at.timeMs / 1000)}`
	}
	if (offsetMs !== 0) out += ` offset ${offsetMs < 0 ? "-" : ""}${formatDuration(Math.abs(offsetMs))}`
	return out
}

const matcher = (m: LabelMatcher): string => `${labelName(m.name)}${m.op}${quote(m.value)}`

const selector = (s: VectorSelector, range: string): string => {
	const isName = (m: LabelMatcher) => m.name === "__name__" && m.op === "=" && m.value === s.name
	// A second name matcher, even an identical one, only parses spelled out as `__name__=...`.
	const spellOut = s.matchers.filter((m) => m.name === "__name__").length > 1
	const nameIsIdentifier =
		!spellOut && s.name !== undefined && IDENTIFIER.test(s.name) && !RESERVED.has(s.name.toLowerCase())
	const rest = s.matchers.filter((m) => !(nameIsIdentifier && isName(m)))
	const parts = rest.map((m) => (!spellOut && isName(m) ? quote(m.value) : matcher(m)))
	const head = nameIsIdentifier ? (s.name ?? "") : ""
	const block = parts.length > 0 || head === "" ? `{${parts.join(", ")}}` : ""
	return `${head}${block}${range}${modifiers(s.offsetMs, s.at)}`
}

const grouping = (labels: ReadonlyArray<string>): string => `(${labels.map(labelName).join(", ")})`

/** Prometheus' binary precedence, loosest first; `^` alone is right-associative. */
const PRECEDENCE = {
	or: 1,
	and: 2,
	unless: 2,
	"==": 3,
	"!=": 3,
	">": 3,
	"<": 3,
	">=": 3,
	"<=": 3,
	"+": 4,
	"-": 4,
	"*": 5,
	"/": 5,
	"%": 5,
	atan2: 5,
	"^": 6,
} satisfies Record<string, number>

const precedence = (op: string): number => lookup(PRECEDENCE, op) ?? 0

/** A binary operand, parenthesized only where precedence or associativity would regroup it. */
const operand = (child: Expr, parentOp: string, side: "lhs" | "rhs"): string => {
	const parent = precedence(parentOp)
	if (child.type === "Binary") {
		const own = precedence(child.op)
		const rightAssoc = parentOp === "^"
		const regroups = own < parent || (own === parent && (rightAssoc ? side === "lhs" : side === "rhs"))
		return regroups ? `(${print(child)})` : print(child)
	}
	// `-a ^ b` and `-2 ^ b` are `-(a ^ b)`, so a negated base needs its parentheses.
	const negated =
		child.type === "Unary" ||
		(child.type === "NumberLiteral" && (child.value < 0 || Object.is(child.value, -0)))
	if (negated && parentOp === "^" && side === "lhs") return `(${print(child)})`
	return print(child)
}

/** A subquery body or negated operand that is itself an operator keeps its parentheses. */
const wrapped = (expr: Expr): string =>
	expr.type === "Binary" || expr.type === "Unary" ? `(${print(expr)})` : print(expr)

/** Print an expression as PromQL. Parsing the output yields the same AST. */
export const print = (expr: Expr): string => {
	switch (expr.type) {
		case "NumberLiteral":
			return number(expr.value)
		case "StringLiteral":
			return quote(expr.value)
		case "VectorSelector":
			return selector(expr, "")
		case "MatrixSelector":
			return selector(expr.vector, `[${formatDuration(expr.rangeMs)}]`)
		case "Subquery":
			return `${wrapped(expr.expr)}[${formatDuration(expr.rangeMs)}:${
				expr.stepMs === undefined ? "" : formatDuration(expr.stepMs)
			}]${modifiers(expr.offsetMs, expr.at)}`
		case "Call":
			return `${expr.func}(${expr.args.map(print).join(", ")})`
		case "Paren":
			return `(${print(expr.expr)})`
		case "Unary": {
			// A unary operator binds like `*`, so only a `^` operand prints bare.
			const bare = expr.expr.type !== "Binary" || expr.expr.op === "^"
			return `${expr.op}${bare ? print(expr.expr) : `(${print(expr.expr)})`}`
		}
		case "Aggregate": {
			const args =
				expr.param === undefined ? print(expr.expr) : `${print(expr.param)}, ${print(expr.expr)}`
			const mod =
				expr.without || expr.grouping.length > 0
					? ` ${expr.without ? "without" : "by"} ${grouping(expr.grouping)}`
					: ""
			return `${expr.op}${mod} (${args})`
		}
		case "Binary": {
			let mod = expr.returnBool ? " bool" : ""
			const m = expr.matching
			// An explicit empty ignoring() is part of the AST; keep it so the output re-parses the same.
			if (m !== undefined) mod += ` ${m.on ? "on" : "ignoring"}${grouping(m.labels)}`
			if (m?.card === "many-to-one") mod += ` group_left${grouping(m.include)}`
			if (m?.card === "one-to-many") mod += ` group_right${grouping(m.include)}`
			return `${operand(expr.lhs, expr.op, "lhs")} ${expr.op}${mod} ${operand(expr.rhs, expr.op, "rhs")}`
		}
	}
}
