import {
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

export const ActionType = Schema.Literals(["drop", "redact"])
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
}

// FIELDS AND OPS (which op a field allows comes from `@maple/domain/ingest-rules`)

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

// DRAFT TO SPEC

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
		// @effect-diagnostics-next-line preferEffectString:off -- function replacer; Str.replace only takes a string
		Arr.map(values, (value) => value.replace(/[\\,]/gu, (char) => `\\${char}`)),
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
