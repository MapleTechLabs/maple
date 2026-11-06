import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import { IngestRuleId } from "./primitives"

// Customer ingest rules: drop or redact telemetry before the gateway stores or bills it.
// This file is the contract. The Rust gateway (`apps/ingest/src/ingest_rules.rs`) and the TS
// engine (`@maple/ingest-rules`) both implement it and are held to it by shared fixtures.

export const INGEST_RULE_LIMITS = {
	rulesPerOrg: 50,
	conditionsPerRule: 20,
	valuesPerCondition: 100,
	valueLength: 1024,
	keysPerRule: 32,
	patternsPerRule: 10,
	patternLength: 512,
	nameLength: 120,
	/** Highest `position` a rule can have. */
	maxPosition: 10_000,
	/** Detectors and patterns read at most this many bytes of one string value. */
	scanBytes: 16 * 1024,
	/**
	 * Estimated MiB of compiled regex (`regexBudgetCost`) across all of an org's rules. The
	 * gateway refuses an org whose regexes really compile past 16 MiB, so this keeps headroom.
	 */
	regexBudgetPerOrg: 8,
} as const

export const IngestRuleSignal = Schema.Literals(["traces", "logs", "metrics"])
export type IngestRuleSignal = Schema.Schema.Type<typeof IngestRuleSignal>

/**
 * - `service_name`: the resource's `service.name`.
 * - `name`: span name (traces) or metric name (metrics).
 * - `attribute` / `resource_attribute`: a record or resource attribute, by `key`.
 * - `body`: the log body as a string (logs).
 * - `severity`: the log severity, compared as a number (logs).
 * - `span_kind` / `span_status`: lower-case OTLP names (traces).
 */
export const IngestRuleField = Schema.Literals([
	"service_name",
	"name",
	"attribute",
	"resource_attribute",
	"body",
	"severity",
	"span_kind",
	"span_status",
])
export type IngestRuleField = Schema.Schema.Type<typeof IngestRuleField>

export const IngestRuleOp = Schema.Literals([
	"eq",
	"neq",
	"in",
	"not_in",
	"prefix",
	"contains",
	"regex",
	"exists",
	"not_exists",
	"lt",
	"gte",
])
export type IngestRuleOp = Schema.Schema.Type<typeof IngestRuleOp>

export const IngestRuleCondition = Schema.Struct({
	field: IngestRuleField,
	/** Required for `attribute` and `resource_attribute`, absent otherwise. */
	key: Schema.optionalKey(Schema.String),
	op: IngestRuleOp,
	/** Single operand: eq, neq, prefix, contains, regex, lt, gte. */
	value: Schema.optionalKey(Schema.String),
	/** List operand: in, not_in. */
	values: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type IngestRuleCondition = Schema.Schema.Type<typeof IngestRuleCondition>

export const IngestRuleDetector = Schema.Literals([
	"email",
	"credit_card",
	"jwt",
	"api_token",
	"ipv4",
	"ipv6",
	"phone",
	"iban",
])
export type IngestRuleDetector = Schema.Schema.Type<typeof IngestRuleDetector>

/** Where a redact rule looks. `events` is span event attributes (`exception.message`). */
export const IngestRuleScope = Schema.Literals(["attributes", "resource", "events", "body"])
export type IngestRuleScope = Schema.Schema.Type<typeof IngestRuleScope>

export const IngestRuleRedactMethod = Schema.Literals(["mask", "hash", "remove"])
export type IngestRuleRedactMethod = Schema.Schema.Type<typeof IngestRuleRedactMethod>

export const IngestRuleDropAction = Schema.TaggedStruct("drop", {
	/** Share of matching records kept, 0 to 100. Sampled on trace id, so traces stay whole. */
	keepPercent: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 })),
})
export const IngestRuleRedactAction = Schema.TaggedStruct("redact", {
	/** Attribute keys whose whole value is redacted. `*` matches any run of characters. */
	keys: Schema.Array(Schema.String),
	detectors: Schema.Array(IngestRuleDetector),
	/** Custom regexes; only the matched text is replaced. */
	patterns: Schema.Array(Schema.String),
	scopes: Schema.Array(IngestRuleScope),
	method: IngestRuleRedactMethod,
})
export const IngestRuleAction = Schema.Union([IngestRuleDropAction, IngestRuleRedactAction])
export type IngestRuleAction = Schema.Schema.Type<typeof IngestRuleAction>

/** The part of a rule the engines evaluate; ids, names and timestamps live on the stored row. */
export const IngestRuleSpec = Schema.Struct({
	signals: Schema.Array(IngestRuleSignal),
	conditions: Schema.Array(IngestRuleCondition),
	action: IngestRuleAction,
})
export type IngestRuleSpec = Schema.Schema.Type<typeof IngestRuleSpec>

export const SEVERITY_LEVELS = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const
export type SeverityLevel = keyof typeof SEVERITY_LEVELS

export const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const
export const SPAN_STATUSES = ["unset", "ok", "error"] as const

/**
 * Keys no rule may redact: they route, attribute and bill the data. Only the gateway's own
 * stamps (`maple_org_id`, `maple_source_id`, ...) qualify; `maple_ai.*` copies customer text.
 */
export const isProtectedKey = (key: string): boolean =>
	key === "service.name" || key === "org_id" || /^maple_[a-z0-9_]+$/u.test(key)

const SINGLE_OPS: ReadonlySet<IngestRuleOp> = new Set(["eq", "neq", "prefix", "contains", "regex"])
const LIST_OPS: ReadonlySet<IngestRuleOp> = new Set(["in", "not_in"])
const PRESENCE_OPS: ReadonlySet<IngestRuleOp> = new Set(["exists", "not_exists"])

/** Fields that exist on some signals only; the rest exist on every record. */
const FIELD_SIGNALS = new Map<IngestRuleField, ReadonlyArray<IngestRuleSignal>>([
	["name", ["traces", "metrics"]],
	["body", ["logs"]],
	["severity", ["logs"]],
	["span_kind", ["traces"]],
	["span_status", ["traces"]],
])

const FIELD_OPS = new Map<IngestRuleField, ReadonlySet<IngestRuleOp>>([
	["service_name", new Set([...SINGLE_OPS, ...LIST_OPS])],
	["name", new Set([...SINGLE_OPS, ...LIST_OPS])],
	["attribute", new Set([...SINGLE_OPS, ...LIST_OPS, ...PRESENCE_OPS])],
	["resource_attribute", new Set([...SINGLE_OPS, ...LIST_OPS, ...PRESENCE_OPS])],
	["body", new Set(["eq", "neq", "prefix", "contains", "regex"])],
	["severity", new Set(["lt", "gte"])],
	["span_kind", LIST_OPS],
	["span_status", LIST_OPS],
])

// Constructs one engine supports and the other does not, or that defeat linear-time matching.
const UNPORTABLE_REGEX: ReadonlyArray<readonly [RegExp, string]> = [
	[/\(\?<?[=!]/u, "lookaround is not supported"],
	[/\(\?>/u, "atomic groups are not supported"],
	[/\\[1-9]|\\k</u, "backreferences are not supported"],
	[/(?<!\\)[*+?}]\+/u, "possessive quantifiers are not supported"],
	[/\[[^\]]*(&&|~~|--)/u, "character class set operations are not supported"],
	[/\[\^\]|\\c|\\0/u, "use an explicit class or escape instead"],
	[/\{\s*\d{4,}|\{\s*\d+\s*,\s*\d{4,}/u, "counted repetitions are limited to 999"],
	[/\(\?P/u, "use (?<name>...) for named groups"],
	[/(?!^)\(\?[a-zA-Z-]+[):]/u, "inline flags are only supported as a leading (?i)"],
	[/^\(\?(?!i\))[a-zA-Z-]+\)/u, "only the (?i) inline flag is supported"],
]

interface Quantifier {
	readonly min: number
	readonly max: number
	readonly length: number
}

/** The quantifier at `at`, if any (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each optionally lazy). */
const quantifierAt = (pattern: string, at: number): Quantifier | null => {
	const lazy = (length: number) => (pattern[at + length] === "?" ? length + 1 : length)
	const char = pattern[at]
	if (char === "*") return { min: 0, max: Infinity, length: lazy(1) }
	if (char === "+") return { min: 1, max: Infinity, length: lazy(1) }
	if (char === "?") return { min: 0, max: 1, length: lazy(1) }
	const counted = /^\{(\d+)(,(\d*))?\}/u.exec(Str.slice(at)(pattern))
	if (counted === null) return null
	const min = Number(counted[1])
	const max = counted[2] === undefined ? min : counted[3] === "" ? Infinity : Number(counted[3])
	return { min, max, length: lazy(counted[0].length) }
}

/**
 * True when a group that repeats contains a variable-width repetition or an alternation, at any
 * depth: `(a+)+`, `((a)+)+`, `(?:(a+))+`, `(a{1,2})+`, `(a|aa)+`. The JS engine the preview and local
 * mode use backtracks exponentially on these; the gateway's engine does not, but parity matters.
 */
export const hasRepeatedVariableGroup = (pattern: string): boolean => {
	const stack: Array<{ variable: boolean }> = [{ variable: false }]
	let at = 0
	const top = () => stack[stack.length - 1] ?? { variable: false }
	/** Applies the quantifier after an atom; returns false when a variable group repeats. */
	const afterAtom = (atomVariable: boolean): boolean => {
		const quantifier = quantifierAt(pattern, at)
		if (quantifier === null) {
			if (atomVariable) top().variable = true
			return true
		}
		at += quantifier.length
		if (atomVariable && quantifier.max > 1) return false
		if (atomVariable || quantifier.min !== quantifier.max) top().variable = true
		return true
	}
	while (at < pattern.length) {
		const char = pattern[at]
		if (char === "\\") {
			at = atomEnd(pattern, at)
			if (!afterAtom(false)) return true
		} else if (char === "[") {
			at += pattern[at + 1] === "]" ? 2 : 1
			while (at < pattern.length && pattern[at] !== "]") at += pattern[at] === "\\" ? 2 : 1
			at += 1
			if (!afterAtom(false)) return true
		} else if (char === "(") {
			at += 1
			if (pattern[at] === "?") {
				at += 1
				if (pattern[at] === "<" && pattern[at + 1] !== "=" && pattern[at + 1] !== "!") {
					while (at < pattern.length && pattern[at] !== ">") at += 1
				}
				at += 1
			}
			stack.push({ variable: false })
		} else if (char === ")") {
			at += 1
			const group = stack.length > 1 ? stack.pop() : undefined
			if (!afterAtom(group?.variable ?? false)) return true
		} else if (char === "|") {
			at += 1
			top().variable = true
		} else {
			at += 1
			if (!afterAtom(false)) return true
		}
	}
	return false
}

/** Splits a leading `(?i)` off a pattern; both engines treat it as case-insensitive. */
export const splitRegexFlags = (pattern: string): { readonly source: string; readonly ignoreCase: boolean } =>
	Str.startsWith("(?i)")(pattern)
		? { source: Str.slice(4)(pattern), ignoreCase: true }
		: { source: pattern, ignoreCase: false }

const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}"
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`
const NOT_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`
const SHORTHANDS = new Map([
	["d", "\\p{Nd}"],
	["D", "\\P{Nd}"],
	["w", `[${WORD}]`],
	["W", `[^${WORD}]`],
	["s", "\\p{White_Space}"],
	["S", "\\P{White_Space}"],
	["b", BOUNDARY],
	["B", NOT_BOUNDARY],
])
const CLASS_SHORTHANDS = new Map([
	["d", "\\p{Nd}"],
	["w", WORD],
	["s", "\\p{White_Space}"],
])

/**
 * The JS source that matches what the gateway's `regex` crate matches. Rust's `\d`, `\w`, `\s`
 * and `\b` are Unicode-aware and its `.` only stops at `\n`; JS `u` mode's are ASCII or stop at
 * more line breaks. Null for what JS cannot express: a negated shorthand, `\b` or a nested `[`
 * inside a class.
 */
export const portableRegexSource = (source: string): string | null => {
	const out: Array<string> = []
	let inClass = false
	let at = 0
	while (at < source.length) {
		const char = source[at] ?? ""
		if (char === "\\") {
			const next = source[at + 1] ?? ""
			if (Str.includes(next)("pPux") && source[at + 2] === "{") {
				const end = closingBraceEnd(source, at)
				out.push(Str.slice(at, end)(source))
				at = end
				continue
			}
			const replacement = (inClass ? CLASS_SHORTHANDS : SHORTHANDS).get(next)
			if (inClass && replacement === undefined && Str.includes(next)("DWSbB") && next !== "")
				return null
			out.push(replacement ?? char + next)
			at += 2
			continue
		}
		if (inClass && char === "[") return null
		if (char === "[") inClass = true
		else if (char === "]") inClass = false
		out.push(!inClass && char === "." ? "[^\\n]" : char)
		at += 1
	}
	return Arr.join(out, "")
}

const compileRegex = Option.liftThrowable((source: string, flags: string) => new RegExp(source, flags))

interface Repetition {
	readonly atom: string
	readonly min: number
	readonly max: number
	/** A quantified group or an alternation: never counts as a separator. */
	readonly opaque: boolean
}

/** Splits `source` on `|` outside classes and groups. */
const topLevelBranches = (source: string): Array<string> => {
	const branches: Array<string> = []
	let depth = 0
	let inClass = false
	let start = 0
	for (let at = 0; at < source.length; at += 1) {
		const char = source[at]
		if (char === "\\") at += 1
		else if (inClass) inClass = char !== "]"
		else if (char === "[") inClass = true
		else if (char === "(") depth += 1
		else if (char === ")") depth -= 1
		else if (char === "|" && depth === 0) {
			branches.push(Str.slice(start, at)(source))
			start = at + 1
		}
	}
	branches.push(Str.slice(start)(source))
	return branches
}

/** Just past the first `}` at or after `at`, or the end of `source` when there is none. */
const closingBraceEnd = (source: string, at: number): number =>
	Option.match(Str.indexOf("}")(Str.slice(at)(source)), {
		onNone: () => source.length,
		onSome: (offset) => at + offset + 1,
	})

/** The end of the atom at `at`: an escape, a class, a group or one character. */
const atomEnd = (source: string, at: number): number => {
	const char = source[at]
	if (char === "\\") {
		const kind = source[at + 1] ?? ""
		if (Str.includes(kind)("pPux") && source[at + 2] === "{") {
			// An unclosed `\p{` runs to the end; returning 0 would restart the scan forever.
			return closingBraceEnd(source, at)
		}
		// `\xHH` and `\uHHHH` are one atom; a quantifier after them repeats the whole escape.
		if (kind === "x") return at + 4
		if (kind === "u") return at + 6
		return at + 2
	}
	if (char === "[") {
		let end = source[at + 1] === "^" ? at + 2 : at + 1
		while (end < source.length && source[end] !== "]") end += source[end] === "\\" ? 2 : 1
		return end + 1
	}
	if (char === "(") {
		let depth = 0
		let end = at
		while (end < source.length) {
			const inner = source[end]
			if (inner === "\\") end += 1
			else if (inner === "[") end = atomEnd(source, end) - 1
			else if (inner === "(") depth += 1
			else if (inner === ")" && --depth === 0) return end + 1
			end += 1
		}
		return source.length
	}
	return at + 1
}

/** The inside of a group atom: `(a)`, `(?:a)` and `(?<name>a)` all give `a`. */
const groupBody = (atom: string): string =>
	Str.slice(
		Str.startsWith("(?")(atom)
			? Math.max(2, Option.getOrElse(Str.indexOf(atom[2] === "<" ? ">" : ":")(atom), () => -1) + 1)
			: 1,
		-1,
	)(atom)

/**
 * Share of the gateway's 1 MiB compiled-regex limit one copy of an escape takes, from the most
 * repetitions the `regex` crate compiles: `\w` and the worst `\p{...}` 20, `\d` 204, `.` 1048.
 */
const ESCAPE_WEIGHTS = new Map([
	["p", 1 / 20],
	["P", 1 / 20],
	["w", 1 / 20],
	["W", 1 / 20],
	["D", 1 / 82],
	["d", 1 / 204],
	["S", 1 / 544],
	["s", 1 / 1541],
	["b", 0],
	["B", 0],
])
const LITERAL_WEIGHT = 1 / 10_000
const ANY_WEIGHT = 1 / 1048

/** Code points of `\\x{..}`, `\\xHH`, `\\u{..}` and `\\uHHHH` escapes, in order. */
const escapedCodePoints = (text: string): Array<number> =>
	Arr.map(
		Arr.fromIterable(
			Str.matchAll(/\\[ux]\{([0-9a-fA-F]+)\}|\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/gu)(text),
		),
		(escape) => Number.parseInt(escape[1] ?? escape[2] ?? escape[3] ?? "0", 16),
	)

/** UTF-8 bytes of a literal atom: a character or a `\\x`/`\\u` escape. */
const literalBytes = (atom: string): number => {
	const code = Str.startsWith("\\")(atom)
		? (escapedCodePoints(atom)[0] ?? Option.getOrElse(Str.codePointAt(atom, 1), () => 0))
		: Option.getOrElse(Str.codePointAt(atom, 0), () => 0)
	return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/** True when a class holds a character past ASCII, written out or escaped. */
const hasNonAscii = (atom: string): boolean =>
	/[^\x00-\x7f]/u.test(atom) || Arr.some(escapedCodePoints(atom), (code) => code >= 0x80)

/** `(?i)` turns a literal into a class of its case forms; classes already hold them. */
const atomWeight = (atom: string, ignoreCase: boolean): number => {
	const literal = LITERAL_WEIGHT * literalBytes(atom) * (ignoreCase ? 3 : 1)
	if (Str.startsWith("\\")(atom)) return ESCAPE_WEIGHTS.get(atom[1] ?? "") ?? literal
	if (atom === ".") return ANY_WEIGHT
	if (!Str.startsWith("[")(atom)) return literal
	// `[^\\s]` compiles like `\\S`: a negated class weighs as its members' complements. A class
	// past ASCII compiles to UTF-8 byte ranges about as large as `.`.
	const negated = Str.startsWith("[^")(atom)
	const members = Arr.map(Arr.fromIterable(Str.matchAll(/\\(.)/gu)(atom)), (escape) => {
		const letter = escape[1] ?? ""
		const complement =
			letter === Str.toLowerCase(letter) ? Str.toUpperCase(letter) : Str.toLowerCase(letter)
		return ESCAPE_WEIGHTS.get(negated ? complement : letter) ?? 0
	})
	return Math.max(negated || hasNonAscii(atom) ? ANY_WEIGHT : 1 / 3000, ...members)
}

/** Estimated share of the gateway's compiled-regex limit; copies add up, counted repeats multiply. */
export const compiledRegexWeight = (source: string, ignoreCase = false): number =>
	Arr.reduce(topLevelBranches(source), 0, (total, branch) => {
		let weight = 0
		let at = 0
		while (at < branch.length) {
			const char = branch[at] ?? ""
			if (char === "^" || char === "$") {
				at += 1
				continue
			}
			const end = atomEnd(branch, at)
			const atom = Str.slice(at, end)(branch)
			const quantifier = quantifierAt(branch, end)
			at = end + (quantifier?.length ?? 0)
			const copies =
				quantifier === null ? 1 : quantifier.max === Infinity ? quantifier.min + 1 : quantifier.max
			weight +=
				copies *
				(char === "("
					? compiledRegexWeight(groupBody(atom), ignoreCase)
					: atomWeight(atom, ignoreCase))
		}
		return total + weight
	})

/** A regex's estimated compiled size in MiB, for the per-org budget; each costs at least 16 KiB. */
export const regexBudgetCost = (pattern: string): number => {
	const { source, ignoreCase } = splitRegexFlags(pattern)
	return Math.max(compiledRegexWeight(source, ignoreCase), 1 / 64)
}

/** The atoms of one branch with their repetition; unquantified plain groups are flattened. */
const repetitions = (branch: string): Array<Repetition> => {
	const items: Array<Repetition> = []
	let at = 0
	while (at < branch.length) {
		const char = branch[at] ?? ""
		const next = branch[at + 1] ?? ""
		if (char === "^" || char === "$" || (char === "\\" && Str.includes(next)("bBAz"))) {
			at += char === "\\" ? 2 : 1
			continue
		}
		const end = atomEnd(branch, at)
		const atom = Str.slice(at, end)(branch)
		const quantifier = quantifierAt(branch, end)
		at = end + (quantifier?.length ?? 0)
		if (char === "(") {
			const body = groupBody(atom)
			const plain = quantifier === null && topLevelBranches(body).length === 1
			if (plain) {
				items.push(...repetitions(body))
				continue
			}
			const unbounded = /(?<!\\)[*+]|\{\d+,\}/u.test(body)
			items.push({
				atom,
				min: 0,
				max: unbounded || (quantifier?.max ?? 1) === Infinity ? Infinity : 1,
				opaque: true,
			})
			continue
		}
		items.push({ atom, min: quantifier?.min ?? 1, max: quantifier?.max ?? 1, opaque: false })
	}
	return items
}

/** Characters tried against atoms to decide whether two of them can match the same text. */
const PROBES = [
	...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)),
	...Array.from("\t\n\r  \u0085éßжΣſKİ日٣²😀́‍"),
]

/**
 * True when two wide repetitions can match the same text with no required character between
 * them that neither matches: `a*a*b`, `.*.*=`, `\w+\w+!`. A backtracking engine (the preview's
 * and local mode's) takes cubic time or worse on these; `[a-z]+@[a-z]+` is fine.
 */
export const hasAmbiguousRepetition = (pattern: string): boolean => {
	const { source, ignoreCase } = splitRegexFlags(pattern)
	const matchers = new Map<string, (char: string) => boolean>()
	const matcher = (atom: string) => {
		const cached = matchers.get(atom)
		if (cached !== undefined) return cached
		const regex = compileRegex(`^(?:${portableRegexSource(atom) ?? atom})`, ignoreCase ? "iu" : "u")
		const test = Option.isSome(regex) ? (char: string) => regex.value.test(char) : () => true
		matchers.set(atom, test)
		return test
	}
	const overlap = (left: Repetition, right: Repetition) =>
		Arr.some(PROBES, (char) => matcher(left.atom)(char) && matcher(right.atom)(char))
	const wide = (item: Repetition) => item.max === Infinity || item.max - item.min > 32
	return Arr.some(topLevelBranches(source), (branch) => {
		let open: Array<Repetition> = []
		return Arr.some(repetitions(branch), (item) => {
			if (wide(item) && Arr.some(open, (earlier) => overlap(earlier, item))) return true
			if (item.min >= 1 && !item.opaque) open = Arr.filter(open, (earlier) => overlap(earlier, item))
			if (wide(item)) open.push(item)
			return false
		})
	})
}

/**
 * True when `\\b`, `\\B`, `^` or `$` carries a quantifier outside a class. Repeating an assertion
 * matches nothing new, and JavaScriptCore (Bun, Safari) silently gives up on it on long text.
 */
const hasRepeatedAssertion = (pattern: string): boolean => {
	let inClass = false
	for (let at = 0; at < pattern.length; at += 1) {
		const char = pattern[at]
		const quantified = (offset: number) => {
			const next = pattern[at + offset]
			return next !== undefined && Str.includes(next)("*+?{")
		}
		if (char === "\\") {
			if (!inClass && Str.includes(pattern[at + 1] ?? "")("bB") && quantified(2)) return true
			at += 1
		} else if (inClass) inClass = char !== "]"
		else if (char === "[") {
			inClass = true
			if (pattern[at + 1] === "^") at += 1
			if (pattern[at + 1] === "]") at += 1
		} else if ((char === "^" || char === "$") && quantified(1)) return true
	}
	return false
}

/** Null when the pattern is in the subset both the Rust `regex` crate and JS `RegExp` accept. */
export const regexProblem = (pattern: string): string | null => {
	if (pattern.length === 0) return "pattern is empty"
	if (pattern.length > INGEST_RULE_LIMITS.patternLength)
		return `pattern is longer than ${INGEST_RULE_LIMITS.patternLength} characters`
	for (const [probe, message] of UNPORTABLE_REGEX) if (probe.test(pattern)) return message
	if (hasRepeatedAssertion(pattern)) return "\\b, \\B, ^ and $ cannot be repeated"
	if (portableRegexSource(splitRegexFlags(pattern).source) === null)
		return "inside [...], use explicit characters instead of \\D, \\W, \\S, \\b, \\B or a nested ["
	if (hasRepeatedVariableGroup(pattern))
		return "a repeated group may not contain a repetition or alternation"
	const compiled = compileIngestRegex(pattern, false)
	if (Option.isNone(compiled)) return "pattern is not a valid regular expression"
	const { source, ignoreCase } = splitRegexFlags(pattern)
	if (compiledRegexWeight(source, ignoreCase) > 0.85)
		return "pattern is too large for the gateway to compile; repeat \\w, \\d or \\p{...} less, or use an ASCII class like [A-Za-z0-9_]"
	if (hasAmbiguousRepetition(pattern))
		return "two repetitions that can match the same text need a character neither matches between them (a*a*b is too slow to match)"
	return compiled.value.test("") ? "pattern matches empty text" : null
}

/** The compiled JS form of a pattern that passed `regexProblem`. */
export const compileIngestRegex = (pattern: string, global = true): Option.Option<RegExp> => {
	const { source, ignoreCase } = splitRegexFlags(pattern)
	const portable = portableRegexSource(source)
	return portable === null
		? Option.none()
		: compileRegex(portable, `${global ? "g" : ""}${ignoreCase ? "i" : ""}u`)
}

/** The regexes a rule compiles in the gateway: regex conditions and redact patterns. */
const ruleRegexes = (spec: IngestRuleSpec): ReadonlyArray<string> => [
	...Arr.flatMap(spec.conditions, (condition) =>
		condition.op === "regex" && condition.value !== undefined ? [condition.value] : [],
	),
	...(spec.action._tag === "redact" ? spec.action.patterns : []),
]

/** Estimated MiB of compiled regex the rules need together; see `regexBudgetCost`. */
export const regexBudgetUsed = (specs: ReadonlyArray<IngestRuleSpec>): number =>
	Arr.reduce(Arr.flatMap(specs, ruleRegexes), 0, (total, pattern) => total + regexBudgetCost(pattern))

const regexBudgetProblem = (specs: ReadonlyArray<IngestRuleSpec>, subject: string): string | null => {
	const used = regexBudgetUsed(specs)
	if (used <= INGEST_RULE_LIMITS.regexBudgetPerOrg) return null
	const percent = Math.ceil((used / INGEST_RULE_LIMITS.regexBudgetPerOrg) * 100)
	return `${subject} too large to compile together (${percent}% of the limit); shorten counted repeats like \\d{100} or \\w{10}, or remove patterns or regex conditions`
}

/**
 * Null when every rule an org stores, enabled or not, fits the regex budget together. The gateway
 * compiles them all at once, so one org's patterns are bounded as a whole, not only one by one.
 */
export const orgRegexBudgetProblem = (specs: ReadonlyArray<IngestRuleSpec>): string | null =>
	regexBudgetProblem(specs, "the regexes across this organization's ingest rules are")

/** The ops a field supports, for editors that only offer valid choices. */
export const opsForField = (field: IngestRuleField): ReadonlyArray<IngestRuleOp> =>
	Arr.filter(IngestRuleOp.literals, (op) => FIELD_OPS.get(field)?.has(op) === true)

/** The signals a field exists on; every signal unless it is signal-specific. */
export const signalsForField = (field: IngestRuleField): ReadonlyArray<IngestRuleSignal> =>
	FIELD_SIGNALS.get(field) ?? IngestRuleSignal.literals

const conditionProblem = (
	condition: IngestRuleCondition,
	signals: ReadonlyArray<IngestRuleSignal>,
): string | null => {
	const { field, op } = condition
	if (FIELD_OPS.get(field)?.has(op) !== true) return `${field} does not support ${op}`
	const keyed = field === "attribute" || field === "resource_attribute"
	if (keyed && (condition.key === undefined || condition.key.length === 0)) return `${field} needs a key`
	if (!keyed && condition.key !== undefined) return `${field} takes no key`
	const only = FIELD_SIGNALS.get(field)
	if (only !== undefined && Arr.some(signals, (signal) => !only.includes(signal)))
		return `${field} only applies to ${Arr.join(only, " and ")}`
	if (LIST_OPS.has(op)) {
		const values = condition.values ?? []
		if (values.length === 0) return `${op} needs at least one value`
		if (values.length > INGEST_RULE_LIMITS.valuesPerCondition)
			return `${op} takes at most ${INGEST_RULE_LIMITS.valuesPerCondition} values`
		if (Arr.some(values, (value) => value.length > INGEST_RULE_LIMITS.valueLength))
			return "a value is too long"
		if (
			field === "span_kind" &&
			Arr.some(values, (value) => !Arr.some(SPAN_KINDS, (kind) => kind === value))
		)
			return `span_kind values are ${Arr.join(SPAN_KINDS, ", ")}`
		if (
			field === "span_status" &&
			Arr.some(values, (value) => !Arr.some(SPAN_STATUSES, (status) => status === value))
		)
			return `span_status values are ${Arr.join(SPAN_STATUSES, ", ")}`
		return condition.value === undefined ? null : `${op} takes values, not value`
	}
	if (PRESENCE_OPS.has(op))
		return condition.value === undefined && condition.values === undefined ? null : `${op} takes no value`
	if (condition.value === undefined) return `${op} needs a value`
	if (condition.values !== undefined) return `${op} takes value, not values`
	if (condition.value.length > INGEST_RULE_LIMITS.valueLength) return "the value is too long"
	if (field === "severity" && !Rec.has<string, number>(SEVERITY_LEVELS, condition.value))
		return `severity is one of ${Arr.join(Rec.keys(SEVERITY_LEVELS), ", ")}`
	return op === "regex" ? regexProblem(condition.value) : null
}

/** Every problem with a rule, worded for the person who wrote it. Empty means valid. */
export const ingestRuleProblems = (spec: IngestRuleSpec): ReadonlyArray<string> => {
	const problems: Array<string> = []
	if (spec.signals.length === 0) problems.push("pick at least one signal")
	if (new Set(spec.signals).size !== spec.signals.length) problems.push("a signal is listed twice")
	if (spec.conditions.length > INGEST_RULE_LIMITS.conditionsPerRule)
		problems.push(`at most ${INGEST_RULE_LIMITS.conditionsPerRule} conditions`)
	Arr.forEach(spec.conditions, (condition, index) => {
		const problem = conditionProblem(condition, spec.signals)
		if (problem !== null) problems.push(`condition ${index + 1}: ${problem}`)
	})
	const budget = regexBudgetProblem([spec], "this rule's regexes are")
	if (budget !== null) problems.push(budget)
	const action = spec.action
	if (action._tag === "drop") {
		if (!Number.isInteger(action.keepPercent) || action.keepPercent < 0 || action.keepPercent > 100)
			problems.push("keep percent is a whole number from 0 to 100")
		if (spec.conditions.length === 0) problems.push("a drop rule needs at least one condition")
		if (action.keepPercent > 0 && spec.signals.includes("metrics"))
			problems.push("metrics can only be dropped entirely (keep 0%)")
		return problems
	}
	if (action.keys.length + action.detectors.length + action.patterns.length === 0)
		problems.push("redact at least one key, detector or pattern")
	if (action.keys.length > INGEST_RULE_LIMITS.keysPerRule)
		problems.push(`at most ${INGEST_RULE_LIMITS.keysPerRule} keys`)
	for (const key of action.keys) {
		if (key.length === 0 || key.length > INGEST_RULE_LIMITS.valueLength)
			problems.push("a key is empty or too long")
		else if (isProtectedKey(key)) problems.push(`${key} is used by Maple and cannot be redacted`)
	}
	if (new Set(action.detectors).size !== action.detectors.length)
		problems.push("a detector is listed twice")
	if (action.patterns.length > INGEST_RULE_LIMITS.patternsPerRule)
		problems.push(`at most ${INGEST_RULE_LIMITS.patternsPerRule} patterns`)
	Arr.forEach(action.patterns, (pattern, index) => {
		const problem = regexProblem(pattern)
		if (problem !== null) problems.push(`pattern ${index + 1}: ${problem}`)
	})
	if (action.scopes.length === 0) problems.push("pick at least one place to redact")
	if (action.scopes.includes("body") && !spec.signals.includes("logs"))
		problems.push("body only applies to logs")
	if (action.scopes.includes("events") && !spec.signals.includes("traces"))
		problems.push("events only applies to traces")
	return problems
}

/** A stored rule; the API and the settings page read this, the gateway reads `spec`. */
export const IngestRule = Schema.Struct({
	id: IngestRuleId,
	name: Schema.String,
	enabled: Schema.Boolean,
	position: Schema.Number,
	spec: IngestRuleSpec,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type IngestRule = Schema.Schema.Type<typeof IngestRule>

const OP_WORDS = {
	eq: "is",
	neq: "is not",
	in: "is one of",
	not_in: "is none of",
	prefix: "starts with",
	contains: "contains",
	regex: "matches",
	exists: "is set",
	not_exists: "is not set",
	lt: "is below",
	gte: "is at least",
} satisfies Record<IngestRuleOp, string>

const describeCondition = (condition: IngestRuleCondition): string => {
	const subject = condition.key === undefined ? Str.replace("_", " ")(condition.field) : condition.key
	const operand =
		(condition.values === undefined ? undefined : Arr.join(condition.values, ", ")) ??
		condition.value ??
		""
	return `${subject} ${OP_WORDS[condition.op]}${operand === "" ? "" : ` ${operand}`}`
}

/** One plain-text line, e.g. "Drop logs where severity is below info". */
export const summarizeIngestRule = (spec: IngestRuleSpec): string => {
	const where =
		spec.conditions.length === 0
			? ""
			: ` where ${Arr.join(Arr.map(spec.conditions, describeCondition), " and ")}`
	const signals = Arr.join(spec.signals, " and ")
	const action = spec.action
	if (action._tag === "drop") {
		const keep = action.keepPercent > 0 ? ` (keep ${action.keepPercent}%)` : ""
		return `Drop ${signals}${where}${keep}`
	}
	const targets = Arr.join(
		[...action.keys, ...action.detectors, ...Arr.map(action.patterns, (pattern) => `/${pattern}/`)],
		", ",
	)
	return `${action.method === "hash" ? "Hash" : action.method === "remove" ? "Remove" : "Mask"} ${targets} in ${signals}${where}`
}
