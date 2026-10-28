import { Option, Schema } from "effect"
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
	const counted = /^\{(\d+)(,(\d*))?\}/u.exec(pattern.slice(at))
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
			at += 2
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
export const splitRegexFlags = (
	pattern: string,
): { readonly source: string; readonly ignoreCase: boolean } =>
	pattern.startsWith("(?i)")
		? { source: pattern.slice(4), ignoreCase: true }
		: { source: pattern, ignoreCase: false }

/** Null when the pattern is in the subset both the Rust `regex` crate and JS `RegExp` accept. */
export const regexProblem = (pattern: string): string | null => {
	if (pattern.length === 0) return "pattern is empty"
	if (pattern.length > INGEST_RULE_LIMITS.patternLength)
		return `pattern is longer than ${INGEST_RULE_LIMITS.patternLength} characters`
	for (const [probe, message] of UNPORTABLE_REGEX) if (probe.test(pattern)) return message
	if (hasRepeatedVariableGroup(pattern))
		return "a repeated group may not contain a repetition or alternation"
	const compiled = compileIngestRegex(pattern, false)
	if (Option.isNone(compiled)) return "pattern is not a valid regular expression"
	return compiled.value.test("") ? "pattern matches empty text" : null
}

const compileRegex = Option.liftThrowable((source: string, flags: string) => new RegExp(source, flags))

/** The compiled JS form of a pattern that passed `regexProblem`. */
export const compileIngestRegex = (pattern: string, global = true): Option.Option<RegExp> => {
	const { source, ignoreCase } = splitRegexFlags(pattern)
	return compileRegex(source, `${global ? "g" : ""}${ignoreCase ? "i" : ""}u`)
}

/** The ops a field supports, for editors that only offer valid choices. */
export const opsForField = (field: IngestRuleField): ReadonlyArray<IngestRuleOp> =>
	IngestRuleOp.literals.filter((op) => FIELD_OPS.get(field)?.has(op) === true)

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
	if (only !== undefined && signals.some((signal) => !only.includes(signal)))
		return `${field} only applies to ${only.join(" and ")}`
	if (LIST_OPS.has(op)) {
		const values = condition.values ?? []
		if (values.length === 0) return `${op} needs at least one value`
		if (values.length > INGEST_RULE_LIMITS.valuesPerCondition)
			return `${op} takes at most ${INGEST_RULE_LIMITS.valuesPerCondition} values`
		if (values.some((value) => value.length > INGEST_RULE_LIMITS.valueLength))
			return "a value is too long"
		if (field === "span_kind" && values.some((value) => !SPAN_KINDS.some((kind) => kind === value)))
			return `span_kind values are ${SPAN_KINDS.join(", ")}`
		if (
			field === "span_status" &&
			values.some((value) => !SPAN_STATUSES.some((status) => status === value))
		)
			return `span_status values are ${SPAN_STATUSES.join(", ")}`
		return condition.value === undefined ? null : `${op} takes values, not value`
	}
	if (PRESENCE_OPS.has(op))
		return condition.value === undefined && condition.values === undefined ? null : `${op} takes no value`
	if (condition.value === undefined) return `${op} needs a value`
	if (condition.values !== undefined) return `${op} takes value, not values`
	if (condition.value.length > INGEST_RULE_LIMITS.valueLength) return "the value is too long"
	if (field === "severity" && !Object.hasOwn(SEVERITY_LEVELS, condition.value))
		return `severity is one of ${Object.keys(SEVERITY_LEVELS).join(", ")}`
	return op === "regex" ? regexProblem(condition.value) : null
}

/** Every problem with a rule, worded for the person who wrote it. Empty means valid. */
export const ingestRuleProblems = (spec: IngestRuleSpec): ReadonlyArray<string> => {
	const problems: Array<string> = []
	if (spec.signals.length === 0) problems.push("pick at least one signal")
	if (new Set(spec.signals).size !== spec.signals.length) problems.push("a signal is listed twice")
	if (spec.conditions.length > INGEST_RULE_LIMITS.conditionsPerRule)
		problems.push(`at most ${INGEST_RULE_LIMITS.conditionsPerRule} conditions`)
	spec.conditions.forEach((condition, index) => {
		const problem = conditionProblem(condition, spec.signals)
		if (problem !== null) problems.push(`condition ${index + 1}: ${problem}`)
	})
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
	action.patterns.forEach((pattern, index) => {
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
	const subject = condition.key === undefined ? condition.field.replace("_", " ") : condition.key
	const operand = condition.values?.join(", ") ?? condition.value ?? ""
	return `${subject} ${OP_WORDS[condition.op]}${operand === "" ? "" : ` ${operand}`}`
}

/** One plain-text line, e.g. "Drop logs where severity is below info". */
export const summarizeIngestRule = (spec: IngestRuleSpec): string => {
	const where =
		spec.conditions.length === 0 ? "" : ` where ${spec.conditions.map(describeCondition).join(" and ")}`
	const signals = spec.signals.join(" and ")
	const action = spec.action
	if (action._tag === "drop") {
		const keep = action.keepPercent > 0 ? ` (keep ${action.keepPercent}%)` : ""
		return `Drop ${signals}${where}${keep}`
	}
	const targets = [
		...action.keys,
		...action.detectors,
		...action.patterns.map((pattern) => `/${pattern}/`),
	].join(", ")
	return `${action.method === "hash" ? "Hash" : action.method === "remove" ? "Remove" : "Mask"} ${targets} in ${signals}${where}`
}
