import {
	IngestParseSource,
	IngestTimestampFormat,
	type IngestParseStep,
	IngestRuleDetector,
	IngestRuleField,
	IngestRuleOp,
	IngestRuleRedactMethod,
	IngestRuleScope,
	IngestRuleSignal,
	type IngestRuleAction,
	type IngestRuleCondition,
	type IngestRuleSpec,
	ingestRuleProblems,
	INGEST_RULE_LIMITS,
	opsForField,
	signalsForField,
} from "@maple/domain/ingest-rules"
import { Schema, Array as Arr, String as Str } from "effect"
import { replaceWith } from "@maple/strings"

// The editor's draft: text inputs stay strings until `specOf` turns the draft into a rule.

export const ConditionDraft = Schema.Struct({
	id: Schema.Number,
	field: IngestRuleField,
	key: Schema.String,
	op: IngestRuleOp,
	value: Schema.String,
	/** Comma-separated operand of `in` and `not_in`. */
	values: Schema.String,
})
export type ConditionDraft = typeof ConditionDraft.Type

export const StepKind = Schema.Literals(["json", "regex", "grok", "severity", "timestamp"])
export type StepKind = typeof StepKind.Type

/** One parse step; fields a kind does not use are kept so switching back restores them. */
export const StepDraft = Schema.Struct({
	id: Schema.Number,
	kind: StepKind,
	source: IngestParseSource,
	key: Schema.String,
	pattern: Schema.String,
	prefix: Schema.String,
	format: IngestTimestampFormat,
})
export type StepDraft = typeof StepDraft.Type

export const StepText = Schema.Literals(["key", "pattern", "prefix"])
export type StepText = typeof StepText.Type

export const ActionType = Schema.Literals(["drop", "redact", "parse"])
export type ActionType = typeof ActionType.Type

export const Draft = Schema.Struct({
	name: Schema.String,
	enabled: Schema.Boolean,
	signals: Schema.Array(IngestRuleSignal),
	conditions: Schema.Array(ConditionDraft),
	nextConditionId: Schema.Number,
	actionType: ActionType,
	keepPercent: Schema.String,
	/** Comma-separated key patterns. */
	keys: Schema.String,
	detectors: Schema.Array(IngestRuleDetector),
	/** One pattern per line. */
	patterns: Schema.String,
	scopes: Schema.Array(IngestRuleScope),
	method: IngestRuleRedactMethod,
	steps: Schema.Array(StepDraft),
	nextStepId: Schema.Number,
	/** The signals chosen before switching to parse (which is logs-only), restored on the way back. */
	signalsBeforeParse: Schema.Array(IngestRuleSignal),
})
export type Draft = typeof Draft.Type

export const TextPart = Schema.Literals(["name", "keepPercent", "keys", "patterns"])
export type TextPart = typeof TextPart.Type

export const emptyDraft: Draft = {
	name: "",
	enabled: true,
	signals: ["logs"],
	conditions: [],
	nextConditionId: 1,
	actionType: "drop",
	keepPercent: "0",
	keys: "",
	detectors: [],
	patterns: "",
	scopes: ["attributes"],
	method: "mask",
	steps: [],
	nextStepId: 1,
	signalsBeforeParse: [],
}

export const STEP_LABELS = {
	json: "JSON",
	regex: "Regex",
	grok: "Grok",
	severity: "Severity",
	timestamp: "Timestamp",
} satisfies Record<StepKind, string>

/** A new step reads the body, except severity and time, which usually sit in an attribute. */
export const defaultStep = (id: number, kind: StepKind): StepDraft => ({
	id,
	kind,
	source: kind === "severity" || kind === "timestamp" ? "attribute" : "body",
	key: kind === "severity" ? "level" : kind === "timestamp" ? "timestamp" : "",
	pattern: kind === "grok" ? "%{TIMESTAMP_ISO8601:timestamp} %{LOGLEVEL:level} %{GREEDYDATA:message}" : "",
	prefix: "",
	format: "rfc3339",
})

const stepOf = (draft: StepDraft): IngestParseStep => {
	// Keys and prefixes are literal: a stored rule must round-trip unchanged.
	const key = draft.source === "attribute" ? { key: draft.key } : {}
	const source = { source: draft.source, ...key }
	const prefix = draft.prefix === "" ? {} : { prefix: draft.prefix }
	switch (draft.kind) {
		case "json":
			return { _tag: "json", ...source, ...prefix }
		case "regex":
		case "grok":
			return { _tag: draft.kind, ...source, pattern: draft.pattern, ...prefix }
		case "severity":
			return { _tag: "severity", ...source }
		case "timestamp":
			return { _tag: "timestamp", ...source, format: draft.format }
	}
}

/** The editor's form of a stored step. */
export const stepDraftOf = (step: IngestParseStep, id: number): StepDraft => {
	const base = defaultStep(id, step._tag)
	return {
		...base,
		source: step.source,
		key: step.key ?? "",
		pattern: step._tag === "regex" || step._tag === "grok" ? step.pattern : "",
		prefix:
			step._tag === "json" || step._tag === "regex" || step._tag === "grok" ? (step.prefix ?? "") : "",
		format: step._tag === "timestamp" ? step.format : base.format,
	}
}

// Which op a field allows comes from `@maple/domain/ingest-rules`.

export const FIELD_LABELS = {
	service_name: "service",
	name: "name",
	attribute: "attribute",
	resource_attribute: "resource attribute",
	body: "body",
	severity: "severity",
	span_kind: "span kind",
	span_status: "span status",
} satisfies Record<IngestRuleField, string>

export const OP_LABELS = {
	eq: "is",
	neq: "is not",
	in: "is one of",
	not_in: "is none of",
	prefix: "starts with",
	contains: "contains",
	regex: "matches regex",
	exists: "exists",
	not_exists: "does not exist",
	lt: "is below",
	gte: "is at least",
} satisfies Record<IngestRuleOp, string>

/** Fields that exist on every chosen signal. */
export const fieldsFor = (signals: ReadonlyArray<IngestRuleSignal>): ReadonlyArray<IngestRuleField> =>
	Arr.filter(IngestRuleField.literals, (field) => {
		const only = signalsForField(field)
		return Arr.every(signals, (signal) => only.includes(signal))
	})

export const isKeyed = (field: IngestRuleField): boolean =>
	field === "attribute" || field === "resource_attribute"
export const isListOp = (op: IngestRuleOp): boolean => op === "in" || op === "not_in"
export const isPresenceOp = (op: IngestRuleOp): boolean => op === "exists" || op === "not_exists"

export const defaultCondition = (id: number, field: IngestRuleField): ConditionDraft => ({
	id,
	field,
	key: "",
	op: opsForField(field)[0] ?? "eq",
	value: field === "severity" ? "info" : "",
	values: "",
})

/** Comma-separated and trimmed; `\,` is a literal comma and `\\` a backslash, so values round-trip. */
export const splitList = (text: string): ReadonlyArray<string> =>
	Arr.filter(
		Array.from(Str.matchAll(/(?:\\.|[^,\\])+|\\$/gu)(text), (match) =>
			Str.trim(Str.replace(/\\(.)/gu, "$1")(match[0])),
		),
		(entry) => entry.length > 0,
	)

export const joinList = (values: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(values, (value) => replaceWith(value, /[\\,]/gu, (char) => `\\${char}`)),
		", ",
	)

/** One pattern per line, kept exactly as typed: a leading space can be part of a pattern. */
export const splitLines = (text: string): ReadonlyArray<string> =>
	Arr.filter(Str.split("\n")(text), (line) => Str.trim(line).length > 0)

const conditionOf = (draft: ConditionDraft): IngestRuleCondition => {
	const key = isKeyed(draft.field) ? { key: Str.trim(draft.key) } : {}
	if (isPresenceOp(draft.op)) return { field: draft.field, op: draft.op, ...key }
	if (isListOp(draft.op))
		return { field: draft.field, op: draft.op, ...key, values: splitList(draft.values) }
	return { field: draft.field, op: draft.op, ...key, value: draft.value }
}

/** `NaN` when the text is not a whole number. */
export const keepPercentOf = (text: string): number =>
	/^\d{1,3}$/u.test(Str.trim(text)) ? Number(Str.trim(text)) : Number.NaN

const actionOf = (draft: Draft): IngestRuleAction =>
	draft.actionType === "drop"
		? { _tag: "drop", keepPercent: keepPercentOf(draft.keepPercent) }
		: draft.actionType === "parse"
			? { _tag: "parse", steps: Arr.map(draft.steps, stepOf) }
			: {
					_tag: "redact",
					keys: splitList(draft.keys),
					detectors: draft.detectors,
					patterns: splitLines(draft.patterns),
					scopes: draft.scopes,
					method: draft.method,
				}

export const specOf = (draft: Draft): IngestRuleSpec => ({
	signals: draft.signals,
	conditions: Arr.map(draft.conditions, conditionOf),
	action: actionOf(draft),
})

/** The validator's problems plus the one only the form can have: the name. */
export const draftProblems = (draft: Draft): ReadonlyArray<string> => {
	const name = Str.trim(draft.name)
	return [
		...(name.length === 0 ? ["give the rule a name"] : []),
		...(name.length > INGEST_RULE_LIMITS.nameLength
			? [`the name is longer than ${INGEST_RULE_LIMITS.nameLength} characters`]
			: []),
		...ingestRuleProblems(specOf(draft)),
	]
}
