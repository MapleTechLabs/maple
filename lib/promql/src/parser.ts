import type { SyntaxNode } from "@lezer/common"
import { parser } from "@prometheus-io/lezer-promql"
import { Option, Result } from "effect"
import {
	type AggregateOp,
	type AtModifier,
	type BinaryOp,
	type Expr,
	type LabelMatcher,
	type MatchOp,
	PARAM_AGGREGATES,
	type VectorMatching,
	type VectorSelector,
} from "./ast"
import { functionSignature } from "./functions"
import { lookup } from "./lookup"
import { anchoredRegex, type LabelRegex } from "./regex"
import { parseDurationMs, parseNumber, roundHalfAway, unquote } from "./literals"
import { checkTypes, valueTypeOf } from "./types"

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

const matchesEmpty = (m: LabelMatcher, regex: LabelRegex | undefined): boolean => {
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

type Token =
	| { readonly kind: "operand"; readonly node: SyntaxNode }
	| { readonly kind: "number"; readonly node: SyntaxNode; readonly text: string }
	| { readonly kind: "unary"; readonly op: "-" | "+"; readonly position: number }
	| { readonly kind: "binary"; readonly node: SyntaxNode }
	| { readonly kind: "postfix"; readonly node: SyntaxNode }

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
} satisfies Record<BinaryOp, number>

/** A unary operator takes `*`'s precedence, so its operand only extends over `^`. */
const UNARY_OPERAND_PRECEDENCE = 6

class Converter {
	/** Selectors and subqueries that already carry an `offset`; `offset 0s` leaves the value at 0. */
	private readonly offsetSet = new WeakSet()

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
			let next = atNode.nextSibling
			while (next?.name === "LineComment") next = next.nextSibling
			const value = yield* required(next, node, "missing @ value")
			if (value.name === "AtModifierPreprocessors") {
				const which = value.firstChild?.name
				if (which === "AtStart") return { kind: "start" } as const
				if (which === "AtEnd") return { kind: "end" } as const
			}
			const literal = value.name === "UnaryExpr" ? value.getChild("NumberDurationLiteral") : value
			// The lexer folds a sign into the @ literal (`@ -1`, `@ - 1`), so strip it here.
			const text = literal === null ? "" : this.text(literal).replace(/\s+/g, "")
			const signed = /^[+-]/.test(text)
			const seconds = parseNumber(signed ? text.slice(1) : text)
			if (
				literal?.name === "NumberDurationLiteral" &&
				seconds !== undefined &&
				Number.isFinite(seconds)
			) {
				const negative =
					(value.name === "UnaryExpr" && this.text(value).trim().startsWith("-")) !==
					(signed && text.startsWith("-"))
				// timestamp.FromFloatSeconds: whole milliseconds, halves away from zero.
				const timeMs = roundHalfAway((negative ? -seconds : seconds) * 1000)
				// Prometheus refuses seconds outside int64; ms past 2^53 would also stall grid stepping.
				if (!Number.isSafeInteger(timeMs))
					return yield* fail(value, `timestamp out of bounds for @ modifier: ${this.text(value)}`)
				return { kind: "time", timeMs } as const
			}
			return yield* fail(value, `invalid @ modifier ${this.text(value)}`)
		})
	}

	/** Where each expression starts in the query, for errors found after conversion. */
	readonly positions = new WeakMap<Expr, number>()

	expr(node: SyntaxNode): R<Expr> {
		return Result.map(this.convert(node), (expr) => {
			if (!this.positions.has(expr)) this.positions.set(expr, node.from)
			return expr
		})
	}

	convert(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* (): Generator<R<unknown>, Expr> {
			switch (node.name) {
				case "PromQL": {
					const inner = exprChildren(node)
					if (inner.length !== 1 || inner[0] === undefined)
						return yield* fail(node, "expected one expression")
					return yield* this.expr(inner[0])
				}
				case "NumberDurationLiteral": {
					if (/^[+-]/.test(this.text(node))) return yield* this.operators(node)
					const value = yield* required(
						parseNumber(this.text(node)),
						node,
						`error parsing number: ${this.text(node)}`,
					)
					return { type: "NumberLiteral", value }
				}
				case "StringLiteral":
					return { type: "StringLiteral", value: yield* this.string(node) }
				case "VectorSelector":
					return yield* this.vectorSelector(node)
				case "MatrixSelector": {
					if (node.getChild("VectorSelector") === null) return yield* this.operators(node)
					const vectorNode = yield* required(
						node.getChild("VectorSelector"),
						node,
						"ranges only allowed for vector selectors",
					)
					const rangeMs = yield* this.range(node)
					return { type: "MatrixSelector", vector: yield* this.vectorSelector(vectorNode), rangeMs }
				}
				case "ParenExpr": {
					const inner = yield* required(exprChildren(node)[0], node, "empty parentheses")
					return { type: "Paren", expr: yield* this.expr(inner) }
				}
				case "SubqueryExpr":
				case "OffsetExpr":
				case "StepInvariantExpr":
				case "UnaryExpr":
				case "BinaryExpr":
					return yield* this.operators(node)
				case "FunctionCall":
					return yield* this.call(node)
				case "AggregateExpr":
					return yield* this.aggregate(node)
				default:
					return yield* fail(node, `unsupported syntax: ${node.name}`)
			}
		})
	}

	withModifier(expr: Expr, node: SyntaxNode, mod: { offsetMs?: number; at?: AtModifier }): R<Expr> {
		const misplaced = `${mod.at === undefined ? "offset" : "@"} modifier must be preceded by an instant vector selector or range vector selector or a subquery`
		if (!isModifiable(expr)) return fail(node, misplaced)
		const target = expr.type === "MatrixSelector" ? expr.vector : expr
		if (target.type !== "VectorSelector" && target.type !== "Subquery") return fail(node, misplaced)
		const hasOffset = this.offsetSet.has(target)
		if (mod.offsetMs !== undefined && hasOffset) return fail(node, "offset may not be set multiple times")
		if (mod.at !== undefined && target.at !== undefined)
			return fail(node, "@ may not be set multiple times")
		const offsetMs = mod.offsetMs ?? target.offsetMs
		const at = mod.at ?? target.at
		const marked = <T extends object>(node: T): T => {
			if (hasOffset || mod.offsetMs !== undefined) this.offsetSet.add(node)
			return node
		}
		if (expr.type === "MatrixSelector")
			return Result.succeed({ ...expr, vector: marked({ ...expr.vector, offsetMs, at }) })
		if (expr.type === "VectorSelector") return Result.succeed(marked({ ...expr, offsetMs, at }))
		if (expr.type === "Subquery") return Result.succeed(marked({ ...expr, offsetMs, at }))
		return fail(node, misplaced)
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
			// Prometheus gates these behind --enable-feature=promql-experimental-functions, off by default.
			if (op === "limitk" || op === "limit_ratio")
				return yield* fail(
					node,
					"limitk() and limit_ratio() are experimental and must be enabled with --enable-feature=promql-experimental-functions",
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

	range(node: SyntaxNode): R<number> {
		return Result.gen(this, function* () {
			const rangeNode = yield* required(node.getChild("DurationExpr"), node, "missing range")
			const rangeMs = yield* this.duration(rangeNode)
			if (rangeMs <= 0) return yield* fail(rangeNode, "range must be positive")
			return rangeMs
		})
	}

	/** Lezer's operator tree in source order; signs it folded into number tokens become unary operators. */
	flatten(node: SyntaxNode, out: Token[]): R<Token[]> {
		return Result.gen(this, function* () {
			const inner = () => required(exprChildren(node)[0], node, `missing operand in ${this.text(node)}`)
			switch (node.name) {
				case "BinaryExpr": {
					const [lhs, rhs] = exprChildren(node)
					yield* this.flatten(yield* required(lhs, node, "missing left operand"), out)
					out.push({ kind: "binary", node })
					yield* this.flatten(yield* required(rhs, node, "missing right operand"), out)
					return out
				}
				case "UnaryExpr": {
					const opNode = yield* required(node.getChild("UnaryOp"), node, "missing unary operator")
					out.push({
						kind: "unary",
						op: this.text(opNode) === "-" ? "-" : "+",
						position: node.from,
					})
					return yield* this.flatten(yield* inner(), out)
				}
				case "NumberDurationLiteral": {
					const text = this.text(node)
					const sign = /^([+-])\s*/.exec(text)
					if (sign === null) {
						out.push({ kind: "operand", node })
						return out
					}
					out.push({ kind: "unary", op: sign[1] === "-" ? "-" : "+", position: node.from })
					out.push({ kind: "number", node, text: text.slice(sign[0].length) })
					return out
				}
				case "OffsetExpr":
				case "StepInvariantExpr":
				case "SubqueryExpr":
					yield* this.flatten(yield* inner(), out)
					out.push({ kind: "postfix", node })
					return out
				case "MatrixSelector":
					if (node.getChild("VectorSelector") !== null) break
					yield* this.flatten(yield* inner(), out)
					out.push({ kind: "postfix", node })
					return out
			}
			out.push({ kind: "operand", node })
			return out
		})
	}

	/** Regroups operators by Prometheus' precedence: modifiers bind to the nearest operand, unary minus as `*`. */
	operators(node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* () {
			const tokens = yield* this.flatten(node, [])
			const state = { next: 0 }
			const expr = yield* this.climb(tokens, state, 0)
			if (state.next !== tokens.length) return yield* fail(node, `unexpected ${this.text(node)}`)
			return expr
		})
	}

	climb(tokens: ReadonlyArray<Token>, state: { next: number }, minPrecedence: number): R<Expr> {
		return Result.gen(this, function* () {
			const first = tokens[state.next]
			if (first === undefined) return yield* fail(this.source.length, "unexpected end of input")
			state.next += 1
			let left = yield* this.prefix(first, tokens, state)
			for (let token = tokens[state.next]; token !== undefined; token = tokens[state.next]) {
				if (token.kind === "postfix") {
					state.next += 1
					left = this.located(yield* this.postfix(left, token.node), left)
					continue
				}
				if (token.kind !== "binary") break
				const opNode = yield* required(
					children(token.node).find((c) => lookup(BINARY_OPS, c.name) !== undefined),
					token.node,
					"missing operator",
				)
				const op = yield* required(lookup(BINARY_OPS, opNode.name), opNode, "unknown operator")
				const own = lookup(PRECEDENCE, op) ?? 0
				if (own < minPrecedence) break
				state.next += 1
				const rhs = yield* this.climb(tokens, state, op === "^" ? own : own + 1)
				left = this.located(yield* this.binary(token.node, op, left, rhs), left)
			}
			return left
		})
	}

	prefix(token: Token, tokens: ReadonlyArray<Token>, state: { next: number }): R<Expr> {
		return Result.gen(this, function* () {
			switch (token.kind) {
				case "operand":
					return yield* this.expr(token.node)
				case "number": {
					const value = yield* required(
						parseNumber(token.text),
						token.node,
						`error parsing number: ${token.text}`,
					)
					const literal: Expr = { type: "NumberLiteral", value }
					this.positions.set(literal, token.node.from)
					return literal
				}
				case "unary": {
					// `unary_op expr %prec MUL`: only `^` and modifiers bind tighter.
					const inner = yield* this.climb(tokens, state, UNARY_OPERAND_PRECEDENCE)
					// `-1` is a literal, as in Prometheus' own parser.
					const expr: Expr =
						inner.type === "NumberLiteral"
							? { type: "NumberLiteral", value: token.op === "-" ? -inner.value : inner.value }
							: { type: "Unary", op: token.op, expr: inner }
					this.positions.set(expr, token.position)
					return expr
				}
				default:
					return yield* fail(token.node, `unexpected ${this.text(token.node)}`)
			}
		})
	}

	located(expr: Expr, from: Expr): Expr {
		const position = this.positions.get(from)
		if (!this.positions.has(expr) && position !== undefined) this.positions.set(expr, position)
		return expr
	}

	postfix(expr: Expr, node: SyntaxNode): R<Expr> {
		return Result.gen(this, function* () {
			switch (node.name) {
				case "OffsetExpr": {
					const offsetNode = yield* required(
						node.getChild("OffsetDurationExpr"),
						node,
						"missing offset",
					)
					return yield* this.withModifier(expr, node, { offsetMs: yield* this.offset(offsetNode) })
				}
				case "StepInvariantExpr":
					return yield* this.withModifier(expr, node, { at: yield* this.at(node) })
				case "MatrixSelector": {
					// Prometheus points a misplaced range at its `[`.
					const bracket = this.source.lastIndexOf(
						"[",
						node.getChild("DurationExpr")?.from ?? node.to,
					)
					if (expr.type !== "VectorSelector")
						return yield* fail(bracket, "ranges only allowed for vector selectors")
					if (expr.offsetMs !== 0)
						return yield* fail(bracket, "no offset modifiers allowed before range")
					if (expr.at !== undefined)
						return yield* fail(bracket, "no @ modifiers allowed before range")
					const matrix: Expr = {
						type: "MatrixSelector",
						vector: expr,
						rangeMs: yield* this.range(node),
					}
					return matrix
				}
				default: {
					const durations = children(node).filter((c) => c.name === "DurationExpr")
					const rangeNode = yield* required(durations[0], node, "missing subquery range")
					const rangeMs = yield* this.duration(rangeNode)
					const stepMs = durations[1] === undefined ? undefined : yield* this.duration(durations[1])
					if (rangeMs <= 0) return yield* fail(rangeNode, "zero or negative subquery range")
					if (stepMs !== undefined && stepMs <= 0)
						return yield* fail(node, "zero or negative subquery step")
					const subquery: Expr = {
						type: "Subquery",
						expr,
						rangeMs,
						stepMs,
						offsetMs: 0,
						at: undefined,
					}
					return subquery
				}
			}
		})
	}

	binary(node: SyntaxNode, op: BinaryOp, lhs: Expr, rhs: Expr): R<Expr> {
		return Result.gen(this, function* () {
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
			// Prometheus drops an empty `on()`/`ignoring()` next to a scalar; a non-empty one fails type checks.
			const scalarSide = valueTypeOf(lhs) === "scalar" || valueTypeOf(rhs) === "scalar"
			if (scalarSide && matching?.labels.length === 0) matching = undefined
			const binary: Expr = {
				type: "Binary",
				op,
				lhs,
				rhs,
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

const TRAILING_DOT = /(\d[\d_]*)\.(?![\d_.])([eE][+-]?\d[\d_]*)?/y

/**
 * Prometheus' lexer reads `1.` and `1.e2` as numbers; the lezer grammar wants a digit after
 * the dot. Drop that dot and pad with a space, so every offset stays where it was.
 */
const normalizeTrailingDots = (query: string): string => {
	let out = ""
	let i = 0
	while (i < query.length) {
		const ch = query[i] ?? ""
		if (ch === '"' || ch === "'" || ch === "`") {
			let end = i + 1
			while (end < query.length && query[end] !== ch) end += ch !== "`" && query[end] === "\\" ? 2 : 1
			out += query.slice(i, end + 1)
			i = end + 1
			continue
		}
		if (ch === "#") {
			const newline = query.indexOf("\n", i)
			const end = newline === -1 ? query.length : newline
			out += query.slice(i, end)
			i = end
			continue
		}
		TRAILING_DOT.lastIndex = i
		const match = /[\w:.]/.test(query[i - 1] ?? "") ? null : TRAILING_DOT.exec(query)
		if (match !== null) {
			// With its dot `010.` is a float (10), but `010` alone reads as octal, so leading zeros go. The
			// padding follows the number, so the token still starts where the user wrote it.
			const integer = match[1] ?? ""
			const decimal = integer.replace(/^[0_]+(?=\d)/, "")
			out += `${decimal}${match[2] ?? ""}${" ".repeat(integer.length - decimal.length)} `
			i += match[0].length
			continue
		}
		out += ch
		i += 1
	}
	return out
}

/** Parse and type-check a PromQL query. */
export const parse = (query: string): R<Expr> => {
	if (query.trim().length === 0) return fail(0, "empty query")
	const source = normalizeTrailingDots(query)
	const tree = parser.parse(source)
	const error = firstError(tree.topNode)
	if (error !== null) {
		const near = query.slice(error.from, Math.max(error.to, error.from + 1)).trim()
		return fail(error.from, near.length > 0 ? `syntax error near "${near}"` : "unexpected end of input")
	}
	const converter = new Converter(source)
	return Result.flatMap(converter.expr(tree.topNode), (expr) => {
		const typeError = checkTypes(expr)
		return typeError === undefined
			? Result.succeed(expr)
			: fail(converter.positions.get(typeError.at) ?? 0, typeError.message)
	})
}
