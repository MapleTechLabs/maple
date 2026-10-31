import type {
	IngestRuleAction,
	IngestRuleCondition,
	IngestRuleDetector,
	IngestRuleSignal,
} from "@maple/domain/ingest-rules"
import { FIELD_LABELS, isKeyed, OP_LABELS } from "./form"

// A rule as one plain sentence; `code` parts render as inline code (keys and values).

export type SummaryPart =
	| { readonly _tag: "text"; readonly text: string }
	| { readonly _tag: "code"; readonly text: string }

const text = (value: string): SummaryPart => ({ _tag: "text", text: value })
const code = (value: string): SummaryPart => ({ _tag: "code", text: value })

export const DETECTOR_LABELS = {
	email: "Email addresses",
	credit_card: "Card numbers",
	jwt: "JWTs",
	api_token: "API tokens",
	ipv4: "IPv4 addresses",
	ipv6: "IPv6 addresses",
	phone: "Phone numbers",
	iban: "IBANs",
} satisfies Record<IngestRuleDetector, string>

export const SIGNAL_LABELS = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
} satisfies Record<IngestRuleSignal, string>

const joined = (
	parts: ReadonlyArray<ReadonlyArray<SummaryPart>>,
	last = " and ",
): ReadonlyArray<SummaryPart> =>
	parts.flatMap((part, index) =>
		index === 0 ? part : [text(index === parts.length - 1 ? last : ", "), ...part],
	)

const conditionParts = (condition: IngestRuleCondition): ReadonlyArray<SummaryPart> => {
	const subject = isKeyed(condition.field)
		? [text(`${FIELD_LABELS[condition.field]} `), code(condition.key ?? "")]
		: [text(FIELD_LABELS[condition.field])]
	const operand =
		condition.values !== undefined
			? [
					text(" "),
					...joined(
						condition.values.map((value) => [code(value)]),
						" or ",
					),
				]
			: condition.value === undefined
				? []
				: [text(" "), code(condition.value)]
	return [...subject, text(` ${OP_LABELS[condition.op]}`), ...operand]
}

const actionParts = (action: IngestRuleAction): ReadonlyArray<SummaryPart> => {
	if (action._tag === "drop")
		return action.keepPercent === 0
			? [text("drop")]
			: [text(`keep ${action.keepPercent}%, drop the rest`)]
	const targets = [
		...action.detectors.map((detector) => [text(DETECTOR_LABELS[detector].toLowerCase())]),
		...action.keys.map((key) => [code(key)]),
		...(action.patterns.length === 0
			? []
			: [[text(action.patterns.length === 1 ? "1 pattern" : `${action.patterns.length} patterns`)]]),
	]
	const verb = action.method === "hash" ? "hash" : action.method === "remove" ? "remove" : "mask"
	return [text(`${verb} `), ...joined(targets), text(` in ${action.scopes.join(", ")}`)]
}

export const summaryParts = (rule: {
	readonly conditions: ReadonlyArray<IngestRuleCondition>
	readonly action: IngestRuleAction
}): ReadonlyArray<SummaryPart> => {
	const action = actionParts(rule.action)
	if (rule.conditions.length === 0) return [text("Always "), ...action]
	return [text("Where "), ...joined(rule.conditions.map(conditionParts)), text(": "), ...action]
}
