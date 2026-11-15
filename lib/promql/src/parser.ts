import type { SyntaxNode } from "@lezer/common"
import { parser } from "@prometheus-io/lezer-promql"
import { Option, Result } from "effect"
import type {
	AggregateOp,
	AtModifier,
	BinaryOp,
	Expr,
	LabelMatcher,
	MatchOp,
	VectorMatching,
	VectorSelector,
} from "./ast"
import { functionSignature } from "./functions"
import { lookup } from "./lookup"
import { parseDurationMs, parseNumber, unquote } from "./literals"
import { checkTypes } from "./types"

export interface PromqlSyntaxError {
	readonly message: string
	/** Character offset into the query. */
	readonly position: number
}

type R<A> = Result.Result<A, PromqlSyntaxError>

const fail = (node: SyntaxNode | number, message: string): R<never> =>
	Result.fail({ message, position: typeof node === "number" ? node : node.from })

const required = <A>(value: A | null | undefined, node: SyntaxNode, message: string): R<A> =>
	value === null || value === undefined ? fail(node, message) : Result.succeed(value)

const AGGREGATE_OPS = {
	Sum: "sum",
	Avg: "avg",
	Min: "min",
	Max: "max",
	Count: "count",
	Group: "group",
	Stddev: "stddev",
	Stdvar: "stdvar",
	Topk: "topk",
	Bottomk: "bottomk",
	Quantile: "quantile",
	CountValues: "count_values",
	LimitK: "limitk",
	LimitRatio: "limit_ratio",
} satisfies Record<string, AggregateOp>

const PARAM_AGGREGATES: ReadonlySet<AggregateOp> = new Set([
	"topk",
	"bottomk",
	"quantile",
	"count_values",
	"limitk",
	"limit_ratio",
])

const BINARY_OPS = {
	Add: "+",
	Sub: "-",
	Mul: "*",
	Div: "/",
	Mod: "%",
	Pow: "^",
	Atan2: "atan2",
	Eql: "==",
	Neq: "!=",
	Gtr: ">",
	Lss: "<",
	Gte: ">=",
	Lte: "<=",
	And: "and",
	Or: "or",
	Unless: "unless",
} satisfies Record<string, BinaryOp>

const MATCH_OPS = {
	EqlSingle: "=",
	Neq: "!=",
	EqlRegex: "=~",
	NeqRegex: "!~",
} satisfies Record<string, MatchOp>

const EXPR_NODES: ReadonlySet<string> = new Set([
	"AggregateExpr",
	"BinaryExpr",
	"FunctionCall",
	"MatrixSelector",
	"NumberDurationLiteral",
	"OffsetExpr",
	"ParenExpr",
	"StepInvariantExpr",
	"StringLiteral",
	"SubqueryExpr",
	"UnaryExpr",
	"VectorSelector",
	"AnchoredExpr",
	"SmoothedExpr",
])

const children = (node: SyntaxNode): SyntaxNode[] => {
	const out: SyntaxNode[] = []
	for (let c = node.firstChild; c !== null; c = c.nextSibling) {
		if (c.name !== "LineComment") out.push(c)
	}
	return out
}

const exprChildren = (node: SyntaxNode): SyntaxNode[] => children(node).filter((c) => EXPR_NODES.has(c.name))

const compileRegex = Option.liftThrowable((pattern: string) => new RegExp(`^(?:${pattern})$`))

/** A label regex anchored the way Prometheus anchors it, or None when it does not compile. */
export const anchoredRegex = (pattern: string): Option.Option<RegExp> => compileRegex(pattern)

const matchesEmpty = (m: LabelMatcher, regex: RegExp | undefined): boolean => {
	switch (m.op) {
		case "=":
			return m.value === ""
		case "!=":
			return m.value !== ""
		case "=~":
			return regex?.test("") ?? false
		case "!~":
			return !(regex?.test("") ?? false)
	}
}

const isModifiable = (expr: Expr): boolean =>
	expr.type === "VectorSelector" || expr.type === "MatrixSelector" || expr.type === "Subquery"

class Converter {
	constructor(private readonly source: string) {}

	text(node: SyntaxNode): string {
		return this.source.slice(node.from, node.to)
	}

	string(node: SyntaxNode): R<string> {
		return required(unquote(this.text(node)), node, `invalid string literal ${this.text(node)}`)
	}

	duration(node: SyntaxNode): R<number> {
		// DurationExpr wraps one literal; arithmetic, step() and min_of() are experimental.
		const parts = children(node)
		const literal = parts.length === 1 ? parts[0] : undefined
		if (literal === undefined || literal.name !== "NumberDurationLiteralInDurationContext") {
			return fail(node, `unsupported duration expression ${this.text(node)}`)
		}
		return required(
			parseDurationMs(this.text(literal)),
			literal,
			`invalid duration ${this.text(literal)}`,
		)
	}

	offset(node: SyntaxNode): R<number> {
		return Result.gen(this, function* () {
			const parts = children(node)
			const first = parts[0]
			if (first?.name === "UnaryOp") {
				const inner = yield* required(parts[1], node, "missing offset duration")
				const ms = yield* this.offset(inner)
				return this.text(first) === "-" ? -ms : ms
			}
			if (first?.name === "NumberDurationLiteralInDurationContext") {
				return yield* required(
					parseDurationMs(this.text(first)),
					first,
					`invalid duration ${this.text(first)}`,
				)
			}
			return yield* fail(node, `unsupported offset expression ${this.text(node)}`)
		})
	}

	labelName(node: SyntaxNode): R<string> {
		if (node.name === "LabelName") return Result.succeed(this.text(node))
		return Result.flatMap(
			required(node.getChild("StringLiteral"), node, "missing label name"),
			(literal) => this.string(literal),
		)
	}

	grouping(node: SyntaxNode | null): R<string[]> {
		if (node === null) return Result.succeed([])
		return Result.all(
			children(node)
				.filter((c) => c.name === "LabelName" || c.name === "QuotedLabelName")
				.map((c) => this.labelName(c)),
		)
	}

	matcher(node: SyntaxNode): R<LabelMatcher> {
		return Result.gen(this, function* () {
			const parts = children(node)
			const nameNode = yield* required(parts[0], node, "missing label name")
			const opNode = yield* required(
				node.getChild("MatchOp")?.firstChild,
				node,
				"missing match operator",
			)
			const valueNode = yield* required(parts[parts.length - 1], node, "missing label value")
			const op = yield* required(
				lookup(MATCH_OPS, opNode.name),
				opNode,
				`unknown match operator ${this.text(opNode)}`,
			)
			const matcher: LabelMatcher = {
				name: yield* this.labelName(nameNode),
				op,
				value: yield* this.string(valueNode),
			}
			if ((op === "=~" || op === "!~") && Option.isNone(anchoredRegex(matcher.value))) {
				return yield* fail(valueNode, `invalid regular expression ${JSON.stringify(matcher.value)}`)
			}
			return matcher
		})
	}

	vectorSelector(node: SyntaxNode): R<VectorSelector> {
		return Result.gen(this, function* () {
			let name: string | undefined
			const matchers: LabelMatcher[] = []
			const identifier = node.getChild("Identifier")
			if (identifier !== null) name = this.text(identifier)
			const block = node.getChild("LabelMatchers")
			for (const entry of block === null ? [] : children(block)) {
				if (entry.name === "QuotedLabelName") {
					if (name !== undefined) return yield* fail(entry, "metric name must not be set twice")
					name = yield* this.labelName(entry)
				} else if (entry.name === "UnquotedLabelMatcher" || entry.name === "QuotedLabelMatcher") {
					matchers.push(yield* this.matcher(entry))
				}
			}
			const nameMatcher = matchers.find((m) => m.name === "__name__")
			if (name !== undefined) {
				if (nameMatcher !== undefined) return yield* fail(node, "metric name must not be set twice")
				matchers.unshift({ name: "__name__", op: "=", value: name })
			} else if (nameMatcher?.op === "=") {
				name = nameMatcher.value
			}
			const allEmpty = matchers.every((m) =>
				matchesEmpty(
					m,
					Option.getOrUndefined(
						m.op === "=~" || m.op === "!~" ? anchoredRegex(m.value) : Option.none(),
					),
				),
			)
			if (allEmpty)
				return yield* fail(node, "vector selector must contain at least one non-empty matcher")
			const selector: VectorSelector = {
				type: "VectorSelector",
				name,
				matchers,
				offsetMs: 0,
				at: undefined,
			}
			return selector
		})
	}

	at(node: SyntaxNode): R<AtModifier> {
		return Result.gen(this, function* () {
			const atNode = yield* required(node.getChild("At"), node, "missing @")
			const value = yield* required(atNode.nextSibling, node, "missing @ value")
			if (value.name === "AtModifierPreprocessors") {
				const which = value.firstChild?.name
				if (which === "AtStart") return { kind: "start" } as const
				if (which === "AtEnd") return { kind: "end" } as const
			}
			const literal = value.name === "UnaryExpr" ? value.getChild("NumberDurationLiteral") : value
			const seconds = literal === null ? undefined : parseNumber(this.text(literal))
			if (
				literal?.name === "NumberDurationLiteral" &&
				seconds !== undefined &&
				Number.isFinite(seconds)
			) {
				const negative = value.name === "UnaryExpr" && this.text(value).trim().startsWith("-")
				return { kind: "time", timeMs: (negative ? -seconds : seconds) * 1000 } as const
			}
			return yield* fail(value, `invalid @ modifier ${this.text(value)}`)
		})
	}

	expr(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* (): Generator<R<unknown>, Expr> {
			switch (node.name) {
				case "PromQL": {
					const inner = exprChildren(node)
					if (inner.length !== 1 || inner[0] === undefined)
						return yield* fail(node, "expected one expression")
					return yield* this.expr(inner[0])
				}
				case "NumberDurationLiteral": {
					const value = yield* required(
						parseNumber(this.text(node)),
						node,
						`invalid number ${this.text(node)}`,
					)
					return { type: "NumberLiteral", value }
				}
				case "StringLiteral":
					return { type: "StringLiteral", value: yield* this.string(node) }
				case "VectorSelector":
					return yield* this.vectorSelector(node)
				case "MatrixSelector": {
					const vectorNode = yield* required(
						node.getChild("VectorSelector"),
						node,
						"ranges only allowed for vector selectors",
					)
					const rangeNode = yield* required(node.getChild("DurationExpr"), node, "missing range")
					const rangeMs = yield* this.duration(rangeNode)
					if (rangeMs <= 0) return yield* fail(rangeNode, "range must be positive")
					return { type: "MatrixSelector", vector: yield* this.vectorSelector(vectorNode), rangeMs }
				}
				case "SubqueryExpr": {
					const inner = yield* required(exprChildren(node)[0], node, "missing subquery expression")
					const durations = children(node).filter((c) => c.name === "DurationExpr")
					const rangeNode = yield* required(durations[0], node, "missing subquery range")
					const rangeMs = yield* this.duration(rangeNode)
					const stepMs = durations[1] === undefined ? undefined : yield* this.duration(durations[1])
					return {
						type: "Subquery",
						expr: yield* this.expr(inner),
						rangeMs,
						stepMs,
						offsetMs: 0,
						at: undefined,
					}
				}
				case "OffsetExpr": {
					const inner = yield* required(
						exprChildren(node)[0],
						node,
						"missing expression before offset",
					)
					const offsetNode = yield* required(
						node.getChild("OffsetDurationExpr"),
						node,
						"missing offset",
					)
					const offsetMs = yield* this.offset(offsetNode)
					return yield* this.withModifier(yield* this.expr(inner), node, { offsetMs })
				}
				case "StepInvariantExpr": {
					const inner = yield* required(exprChildren(node)[0], node, "missing expression before @")
					const at = yield* this.at(node)
					return yield* this.withModifier(yield* this.expr(inner), node, { at })
				}
				case "ParenExpr": {
					const inner = yield* required(exprChildren(node)[0], node, "empty parentheses")
					return { type: "Paren", expr: yield* this.expr(inner) }
				}
				case "UnaryExpr": {
					const opNode = yield* required(node.getChild("UnaryOp"), node, "missing unary operator")
					const inner = yield* required(exprChildren(node)[0], node, "missing operand")
					const op = this.text(opNode) === "-" ? "-" : "+"
					const expr = yield* this.expr(inner)
					// `-1` is a literal, as in Prometheus' own parser.
					if (expr.type === "NumberLiteral") {
						return { type: "NumberLiteral", value: op === "-" ? -expr.value : expr.value }
					}
					return { type: "Unary", op, expr }
				}
				case "FunctionCall":
					return yield* this.call(node)
				case "AggregateExpr":
					return yield* this.aggregate(node)
				case "BinaryExpr":
					return yield* this.binary(node)
				default:
					return yield* fail(node, `unsupported syntax: ${node.name}`)
			}
		})
	}

	withModifier(expr: Expr, node: SyntaxNode, mod: { offsetMs?: number; at?: AtModifier }): R<Expr> {
		if (!isModifiable(expr))
			return fail(node, "offset and @ modifiers must follow a selector or subquery")
		const target = expr.type === "MatrixSelector" ? expr.vector : expr
		if (target.type !== "VectorSelector" && target.type !== "Subquery") {
			return fail(node, "offset and @ modifiers must follow a selector or subquery")
		}
		if (mod.offsetMs !== undefined && target.offsetMs !== 0)
			return fail(node, "offset may not be set multiple times")
		if (mod.at !== undefined && target.at !== undefined)
			return fail(node, "@ may not be set multiple times")
		const offsetMs = mod.offsetMs ?? target.offsetMs
		const at = mod.at ?? target.at
		if (expr.type === "MatrixSelector")
			return Result.succeed({ ...expr, vector: { ...expr.vector, offsetMs, at } })
		if (expr.type === "VectorSelector") return Result.succeed({ ...expr, offsetMs, at })
		if (expr.type === "Subquery") return Result.succeed({ ...expr, offsetMs, at })
		return fail(node, "offset and @ modifiers must follow a selector or subquery")
	}

	call(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* () {
			const identifier = yield* required(
				node.getChild("FunctionIdentifier"),
				node,
				"missing function name",
			)
			const func = this.text(identifier)
			if (functionSignature(func) === undefined)
				return yield* fail(identifier, `unknown or unsupported function "${func}"`)
			const body = node.getChild("FunctionCallBody")
			const args = yield* Result.all(body === null ? [] : exprChildren(body).map((c) => this.expr(c)))
			const call: Expr = { type: "Call", func, args }
			return call
		})
	}

	aggregate(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* () {
			const opNode = yield* required(
				node.getChild("AggregateOp")?.firstChild,
				node,
				"missing aggregation",
			)
			const op = yield* required(
				lookup(AGGREGATE_OPS, opNode.name),
				opNode,
				`unknown aggregation ${this.text(opNode)}`,
			)
			const body = yield* required(node.getChild("FunctionCallBody"), node, "missing aggregation body")
			const args = yield* Result.all(exprChildren(body).map((c) => this.expr(c)))
			const modifier = node.getChild("AggregateModifier")
			const without = modifier !== null && modifier.getChild("Without") !== null
			const grouping = yield* this.grouping(modifier?.getChild("GroupingLabels") ?? null)
			const wantsParam = PARAM_AGGREGATES.has(op)
			const expected = wantsParam ? 2 : 1
			if (args.length !== expected) {
				return yield* fail(
					body,
					`wrong number of arguments for aggregate expression provided, expected ${expected}, got ${args.length}`,
				)
			}
			const expr = yield* required(args[args.length - 1], body, "missing aggregation argument")
			const aggregate: Expr = {
				type: "Aggregate",
				op,
				expr,
				param: wantsParam ? args[0] : undefined,
				grouping,
				without,
			}
			return aggregate
		})
	}

	binary(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* () {
			const parts = children(node)
			const operands = parts.filter((c) => EXPR_NODES.has(c.name))
			const lhsNode = yield* required(operands[0], node, "missing left operand")
			const rhsNode = yield* required(operands[1], node, "missing right operand")
			const opNode = yield* required(
				parts.find((c) => lookup(BINARY_OPS, c.name) !== undefined),
				node,
				"missing operator",
			)
			const op = yield* required(lookup(BINARY_OPS, opNode.name), opNode, "unknown operator")
			if (node.getChild("FillModifier") !== null)
				return yield* fail(node, "fill modifiers are not supported")
			const clause = node.getChild("MatchingModifierClause")
			let matching: VectorMatching | undefined
			if (clause !== null) {
				const groups = children(clause).filter((c) => c.name === "GroupingLabels")
				const groupLeft = clause.getChild("GroupLeft") !== null
				const groupRight = clause.getChild("GroupRight") !== null
				matching = {
					card: groupLeft ? "many-to-one" : groupRight ? "one-to-many" : "one-to-one",
					on: clause.getChild("On") !== null,
					labels: yield* this.grouping(groups[0] ?? null),
					include: yield* this.grouping(groups[1] ?? null),
				}
			}
			const binary: Expr = {
				type: "Binary",
				op,
				lhs: yield* this.expr(lhsNode),
				rhs: yield* this.expr(rhsNode),
				returnBool: node.getChild("BoolModifier") !== null,
				matching,
			}
			return binary
		})
	}
}

const firstError = (root: SyntaxNode): SyntaxNode | null => {
	let found: SyntaxNode | null = null
	root.cursor().iterate((ref) => {
		if (found !== null) return false
		if (ref.type.isError) found = ref.node
		return undefined
	})
	return found
}

/** Parse and type-check a PromQL query. */
export const parse = (query: string): R<Expr> => {
	if (query.trim().length === 0) return fail(0, "empty query")
	const tree = parser.parse(query)
	const error = firstError(tree.topNode)
	if (error !== null) {
		const near = query.slice(error.from, Math.max(error.to, error.from + 1)).trim()
		return fail(error.from, near.length > 0 ? `syntax error near "${near}"` : "unexpected end of input")
	}
	return Result.flatMap(new Converter(query).expr(tree.topNode), (expr) => {
		const typeError = checkTypes(expr)
		return typeError === undefined ? Result.succeed(expr) : fail(0, typeError)
	})
}
