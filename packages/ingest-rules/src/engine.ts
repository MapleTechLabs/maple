import {
	INGEST_RULE_LIMITS,
	SEVERITY_LEVELS,
	compileIngestRegex,
	ingestRuleProblems,
	isProtectedKey,
	type IngestRuleCondition,
	type IngestRuleDetector,
	type IngestRuleRedactMethod,
	type IngestRuleScope,
	type IngestRuleSignal,
	type IngestRuleSpec,
} from "@maple/domain/ingest-rules"
import { Option } from "effect"
import { DETECTORS, findAll, type Span } from "./detectors"
import { hmacSha256, sha256, toHex, utf8 } from "./sha256"

// The TS twin of `apps/ingest/src/ingest_rules.rs`; semantics in docs/ingest-rules.md.

export type AttrValue = string | number | bigint | boolean | Uint8Array | ReadonlyArray<AttrValue> | AttrMap
export interface AttrMap {
	readonly [key: string]: AttrValue
}

export interface RuleEvent {
	readonly name: string
	readonly attributes: AttrMap
}

/** One span, log record or metric data point, with its resource. */
export interface RuleRecord {
	readonly signal: IngestRuleSignal
	readonly resource: AttrMap
	readonly attributes: AttrMap
	readonly name?: string
	readonly body?: AttrValue
	readonly severityNumber?: number
	readonly severityText?: string
	readonly traceId?: string
	readonly spanKind?: string
	readonly spanStatus?: string
	/** Span status message; scanned under the `attributes` scope. */
	readonly statusMessage?: string
	readonly events?: ReadonlyArray<RuleEvent>
}

interface CompiledCondition {
	readonly condition: IngestRuleCondition
	readonly values: ReadonlySet<string>
	readonly regex: RegExp | null
}

interface CompiledRule {
	readonly index: number
	readonly spec: IngestRuleSpec
	readonly signals: ReadonlySet<IngestRuleSignal>
	readonly conditions: ReadonlyArray<CompiledCondition>
	readonly keys: ReadonlyArray<string>
	readonly patterns: ReadonlyArray<RegExp>
}

export interface InvalidRule {
	readonly index: number
	readonly problems: ReadonlyArray<string>
}

export interface CompiledRules {
	readonly rules: ReadonlyArray<CompiledRule>
	readonly invalid: ReadonlyArray<InvalidRule>
	readonly salt: Uint8Array
}

export type RuleOutcome =
	| { readonly _tag: "dropped"; readonly ruleIndex: number; readonly matched: ReadonlyArray<number> }
	| {
			readonly _tag: "kept"
			readonly record: RuleRecord
			readonly matched: ReadonlyArray<number>
			/** Values replaced or removed, per rule index. */
			readonly redactions: ReadonlyMap<number, number>
	  }

const compileCondition = (condition: IngestRuleCondition): CompiledCondition => ({
	condition,
	values: new Set(condition.values ?? []),
	regex:
		condition.op === "regex" && condition.value !== undefined
			? Option.getOrNull(compileIngestRegex(condition.value, false))
			: null,
})

/** Rules keep their array index, which callers map back to rule ids. Invalid rules are skipped. */
export const compileRules = (specs: ReadonlyArray<IngestRuleSpec>, salt: string): CompiledRules => {
	const rules: Array<CompiledRule> = []
	const invalid: Array<InvalidRule> = []
	specs.forEach((spec, index) => {
		const problems = ingestRuleProblems(spec)
		if (problems.length > 0) {
			invalid.push({ index, problems })
			return
		}
		const action = spec.action
		rules.push({
			index,
			spec,
			signals: new Set(spec.signals),
			conditions: spec.conditions.map(compileCondition),
			keys: action._tag === "redact" ? action.keys.map((key) => key.toLowerCase()) : [],
			patterns:
				action._tag === "redact"
					? action.patterns.flatMap((pattern) => Option.toArray(compileIngestRegex(pattern)))
					: [],
		})
	})
	return { rules, invalid, salt: utf8(salt) }
}

// CONDITIONS

export const isAttrList = (value: AttrValue): value is ReadonlyArray<AttrValue> => Array.isArray(value)
const isMap = (value: AttrValue): value is AttrMap =>
	typeof value === "object" && !isAttrList(value) && !(value instanceof Uint8Array)

/** A double as Rust's `{}` prints it: never exponent form, `-0` kept, `inf`/`NaN` spelled out. */
export const formatDouble = (value: number): string => {
	if (Number.isNaN(value)) return "NaN"
	if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf"
	if (Object.is(value, -0)) return "-0"
	const text = String(Math.abs(value))
	if (!text.includes("e")) return String(value)
	// Shortest round-trip digits, then shifted: `1e+21` is "1000000000000000000000", `1.5e-7` "0.00000015".
	const [mantissa = "", exponentText = "0"] = text.split("e")
	const digits = mantissa.replace(".", "")
	const point =
		(mantissa.indexOf(".") === -1 ? mantissa.length : mantissa.indexOf(".")) + Number(exponentText)
	const unsigned =
		point >= digits.length
			? digits + "0".repeat(point - digits.length)
			: point <= 0
				? `0.${"0".repeat(-point)}${digits}`
				: `${digits.slice(0, point)}.${digits.slice(point)}`
	return value < 0 ? `-${unsigned}` : unsigned
}

/** The string a value compares as; null for bytes, arrays and kvlists. */
export const comparable = (value: AttrValue): string | null => {
	if (typeof value === "string") return value
	if (typeof value === "number") return formatDouble(value)
	if (typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "true" : "false"
	return null
}

const SEVERITY_PREFIXES: ReadonlyArray<readonly [string, number]> = [
	["trace", 1],
	["debug", 5],
	["info", 9],
	["warn", 13],
	["err", 17],
	["fatal", 21],
	["crit", 21],
	["emerg", 21],
]

const SEVERITY_BY_NAME: ReadonlyMap<string, number> = new Map(Object.entries(SEVERITY_LEVELS))

const severityOf = (record: RuleRecord): number | null => {
	if (record.severityNumber !== undefined && record.severityNumber > 0) return record.severityNumber
	const text = (record.severityText ?? "").toLowerCase()
	return SEVERITY_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? null
}

/** Own keys only: an attribute named `constructor` is not inherited from `Object.prototype`. */
const ownValue = (map: AttrMap, key: string): AttrValue | undefined =>
	Object.hasOwn(map, key) ? map[key] : undefined

/** `undefined` = missing, `null` = present but not comparable. */
const fieldValue = (record: RuleRecord, condition: IngestRuleCondition): string | null | undefined => {
	switch (condition.field) {
		case "service_name": {
			const service = ownValue(record.resource, "service.name")
			return service === undefined ? "" : comparable(service)
		}
		case "name":
			return record.name ?? ""
		case "attribute": {
			const value = ownValue(record.attributes, condition.key ?? "")
			return value === undefined ? undefined : comparable(value)
		}
		case "resource_attribute": {
			const value = ownValue(record.resource, condition.key ?? "")
			return value === undefined ? undefined : comparable(value)
		}
		case "body":
			return record.body === undefined ? undefined : comparable(record.body)
		case "span_kind":
			return record.spanKind
		case "span_status":
			return record.spanStatus
		case "severity":
			return undefined
	}
}

const conditionMatches = (record: RuleRecord, compiled: CompiledCondition): boolean => {
	const { condition } = compiled
	if (condition.field === "severity") {
		const severity = severityOf(record)
		const level = SEVERITY_BY_NAME.get(condition.value ?? "")
		if (severity === null || level === undefined) return false
		return condition.op === "lt" ? severity < level : severity >= level
	}
	const value = fieldValue(record, condition)
	if (condition.op === "exists") return value !== undefined
	if (condition.op === "not_exists") return value === undefined
	if (value === undefined) return condition.op === "neq" || condition.op === "not_in"
	if (value === null) return false
	const operand = condition.value ?? ""
	switch (condition.op) {
		case "eq":
			return value === operand
		case "neq":
			return value !== operand
		case "in":
			return compiled.values.has(value)
		case "not_in":
			return !compiled.values.has(value)
		case "prefix":
			return value.startsWith(operand)
		case "contains":
			return value.includes(operand)
		case "regex":
			return (
				compiled.regex !== null && compiled.regex.test(value.slice(0, INGEST_RULE_LIMITS.scanBytes))
			)
		default:
			return false
	}
}

const ruleMatches = (rule: CompiledRule, record: RuleRecord): boolean =>
	rule.signals.has(record.signal) &&
	rule.conditions.every((condition) => conditionMatches(record, condition))

// SAMPLING

/** Deterministic on trace id, so every span and log of one trace gets the same answer. */
export const keepBySample = (
	traceId: string | undefined,
	keepPercent: number,
	random: () => number,
): boolean => {
	if (keepPercent >= 100) return true
	if (keepPercent <= 0) return false
	if (traceId === undefined || traceId.length === 0) return random() * 100 < keepPercent
	const digest = sha256(utf8(traceId.toLowerCase()))
	const head = new DataView(digest.buffer).getBigUint64(0)
	return head % 100n < BigInt(keepPercent)
}

// REDACTION

/** Case-insensitive glob where `*` matches any run of characters; `pattern` is lower-cased. */
export const globMatches = (pattern: string, key: string): boolean => {
	const text = key.toLowerCase()
	let p = 0
	let t = 0
	let star = -1
	let resume = 0
	while (t < text.length) {
		if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
			p++
			t++
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++
			resume = t
		} else if (star !== -1) {
			p = star + 1
			t = ++resume
		} else {
			return false
		}
	}
	while (pattern[p] === "*") p++
	return p === pattern.length
}

const MASK = "[REDACTED]"
const REMOVED = Symbol("removed")

interface RedactContext {
	readonly rule: CompiledRule
	readonly method: IngestRuleRedactMethod
	readonly detectors: ReadonlyArray<IngestRuleDetector>
	readonly salt: Uint8Array
	count: number
}

const hashText = (salt: Uint8Array, text: string) =>
	`hash:${toHex(hmacSha256(salt, utf8(text))).slice(0, 16)}`

const replaceSpans = (
	text: string,
	spans: ReadonlyArray<Span>,
	replace: (matched: string) => string,
): string =>
	spans.reduceRight(
		(acc, span) =>
			acc.slice(0, span.start) + replace(acc.slice(span.start, span.end)) + acc.slice(span.end),
		text,
	)

const scanString = (text: string, ctx: RedactContext): string => {
	const replacement = (label: string | null) => (matched: string) =>
		ctx.method === "hash" ? hashText(ctx.salt, matched) : label === null ? MASK : `[REDACTED:${label}]`
	const tail = text.slice(INGEST_RULE_LIMITS.scanBytes)
	const afterDetectors = ctx.detectors.reduce(
		(head, detector) => {
			const { regex, accept } = DETECTORS[detector]
			const spans = findAll(regex, head, accept)
			ctx.count += spans.length
			return replaceSpans(head, spans, replacement(detector))
		},
		text.slice(0, INGEST_RULE_LIMITS.scanBytes),
	)
	const afterPatterns = ctx.rule.patterns.reduce((head, regex) => {
		const spans = findAll(regex, head, () => true)
		ctx.count += spans.length
		return replaceSpans(head, spans, replacement(null))
	}, afterDetectors)
	return afterPatterns + tail
}

const scanValue = (value: AttrValue, ctx: RedactContext): AttrValue => {
	if (typeof value === "string")
		return ctx.detectors.length + ctx.rule.patterns.length === 0 ? value : scanString(value, ctx)
	if (isAttrList(value)) return value.map((item) => scanValue(item, ctx))
	if (isMap(value)) return redactMap(value, ctx)
	return value
}

const keyReplacement = (value: AttrValue, ctx: RedactContext): AttrValue | typeof REMOVED => {
	ctx.count += 1
	if (ctx.method === "remove") return REMOVED
	if (ctx.method === "hash" && typeof value === "string") return hashText(ctx.salt, value)
	return MASK
}

// `Object.fromEntries` keeps a `__proto__` key as data; assigning it onto `{}` would not.
const redactMap = (map: AttrMap, ctx: RedactContext): AttrMap =>
	Object.fromEntries(
		Object.entries(map).flatMap(([key, value]) => {
			if (isProtectedKey(key)) return [[key, value]]
			const next = ctx.rule.keys.some((pattern) => globMatches(pattern, key))
				? keyReplacement(value, ctx)
				: scanValue(value, ctx)
			return next === REMOVED ? [] : [[key, next]]
		}),
	)

const scopeHas = (rule: CompiledRule, scope: IngestRuleScope) =>
	rule.spec.action._tag === "redact" && rule.spec.action.scopes.includes(scope)

const redactRecord = (
	record: RuleRecord,
	rule: CompiledRule,
	salt: Uint8Array,
): { record: RuleRecord; count: number } => {
	const action = rule.spec.action
	if (action._tag !== "redact") return { record, count: 0 }
	const ctx: RedactContext = { rule, method: action.method, detectors: action.detectors, salt, count: 0 }
	const next: RuleRecord = {
		...record,
		attributes: scopeHas(rule, "attributes") ? redactMap(record.attributes, ctx) : record.attributes,
		resource: scopeHas(rule, "resource") ? redactMap(record.resource, ctx) : record.resource,
		events: scopeHas(rule, "events")
			? record.events?.map((event) => ({ ...event, attributes: redactMap(event.attributes, ctx) }))
			: record.events,
		body: scopeHas(rule, "body") && record.body !== undefined ? scanValue(record.body, ctx) : record.body,
		statusMessage:
			scopeHas(rule, "attributes") && record.statusMessage !== undefined && record.statusMessage !== ""
				? scanString(record.statusMessage, ctx)
				: record.statusMessage,
	}
	return { record: next, count: ctx.count }
}

// APPLY

/** The one random draw a record without a trace id gets, taken on first use. */
interface RecordDraw {
	value?: number
}

export const applyRules = (
	compiled: CompiledRules,
	record: RuleRecord,
	random: () => number = Math.random,
): RuleOutcome => {
	const matching = compiled.rules.filter((rule) => ruleMatches(rule, record))
	const matched = matching.map((rule) => rule.index)
	// One draw per record, shared by every drop rule, as the gateway does for records without a trace id.
	const draw: RecordDraw = {}
	const once = () => (draw.value ??= random())
	const dropper = matching.find(
		(rule) =>
			rule.spec.action._tag === "drop" &&
			!keepBySample(record.traceId, rule.spec.action.keepPercent, once),
	)
	if (dropper !== undefined) return { _tag: "dropped", ruleIndex: dropper.index, matched }
	const redactions = new Map<number, number>()
	const redacted = matching
		.filter((rule) => rule.spec.action._tag === "redact")
		.reduce((current, rule) => {
			const { record: next, count } = redactRecord(current, rule, compiled.salt)
			if (count > 0) redactions.set(rule.index, count)
			return next
		}, record)
	return { _tag: "kept", record: redacted, matched, redactions }
}
