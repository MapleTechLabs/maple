import { fromV2IngestRuleAction, type V2IngestRule } from "@maple/domain/http/v2"
import type { IngestRuleCondition } from "@maple/domain/ingest-rules"
import { type ConditionDraft, type Draft, emptyDraft, joinList } from "./form"

// The empty state's starting points, and the draft an existing rule fills.

export const TEMPLATE_IDS = ["redact-pii", "drop-debug-logs", "drop-health-checks", "hash-user-ids"] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export const isTemplateId = (value: string): value is TemplateId => TEMPLATE_IDS.some((id) => id === value)

const condition = (
	id: number,
	partial: Omit<ConditionDraft, "id" | "key" | "value" | "values"> & Partial<ConditionDraft>,
) => ({
	id,
	key: "",
	value: "",
	values: "",
	...partial,
})

export const TEMPLATES = {
	"redact-pii": {
		label: "Redact emails and card numbers",
		draft: {
			...emptyDraft,
			name: "Redact emails and card numbers",
			signals: ["traces", "logs"],
			actionType: "redact",
			detectors: ["email", "credit_card"],
			scopes: ["attributes", "events", "body"],
		},
	},
	"drop-debug-logs": {
		label: "Drop debug logs",
		draft: {
			...emptyDraft,
			name: "Drop debug logs",
			signals: ["logs"],
			conditions: [condition(1, { field: "severity", op: "lt", value: "info" })],
			nextConditionId: 2,
		},
	},
	"drop-health-checks": {
		label: "Drop health-check spans",
		draft: {
			...emptyDraft,
			name: "Drop health-check spans",
			signals: ["traces"],
			conditions: [
				condition(1, { field: "name", op: "regex", value: "(?i)health|readyz|livez" }),
				condition(2, { field: "span_kind", op: "in", values: "server" }),
			],
			nextConditionId: 3,
		},
	},
	"hash-user-ids": {
		label: "Hash user identifiers",
		draft: {
			...emptyDraft,
			name: "Hash user identifiers",
			signals: ["traces", "logs"],
			actionType: "redact",
			keys: "user.id, enduser.id, user.email",
			scopes: ["attributes"],
			method: "hash",
		},
	},
} satisfies Record<TemplateId, { readonly label: string; readonly draft: Draft }>

const conditionDraft = (rule: IngestRuleCondition, index: number): ConditionDraft => ({
	id: index + 1,
	field: rule.field,
	key: rule.key ?? "",
	op: rule.op,
	value: rule.value ?? "",
	values: joinList(rule.values ?? []),
})

export const draftFromRule = (rule: V2IngestRule): Draft => {
	const action = fromV2IngestRuleAction(rule.action)
	return {
		...emptyDraft,
		name: rule.name,
		enabled: rule.enabled,
		signals: rule.signals,
		conditions: rule.conditions.map(conditionDraft),
		nextConditionId: rule.conditions.length + 1,
		...(action._tag === "drop"
			? { actionType: "drop", keepPercent: String(action.keepPercent) }
			: {
					actionType: "redact",
					keys: joinList(action.keys),
					detectors: action.detectors,
					patterns: action.patterns.join("\n"),
					scopes: action.scopes,
					method: action.method,
				}),
	}
}
