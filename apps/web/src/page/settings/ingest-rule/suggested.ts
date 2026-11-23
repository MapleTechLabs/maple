import type { V2IngestRuleSuggestion } from "@maple/domain/http/v2"
import { AppRoute, hrefOf } from "../../../route"
import { INGEST_RULE_LIMITS } from "@maple/domain/ingest-rules"
import { String as Str } from "effect"
import { type ConditionDraft, type Draft, emptyDraft } from "./form"

// A suggested rule (`GET /v2/ingest_rules/suggestions`) as a link to the editor, and the draft
// that link opens.

/** The new-rule search a suggestion travels in. */
export interface SuggestionSearch {
	readonly service?: string | undefined
	readonly level?: string | undefined
	readonly span?: string | undefined
	readonly keep?: number | undefined
}

export const suggestedRuleHref = (suggestion: V2IngestRuleSuggestion): string =>
	hrefOf(
		AppRoute.IngestRuleNew({
			search: {
				service: suggestion.service_name,
				level: suggestion.level ?? undefined,
				span: suggestion.span_name ?? undefined,
				keep: suggestion.keep_percent,
			},
		}),
	)

const condition = (id: number, field: ConditionDraft["field"], op: ConditionDraft["op"], value: string) => ({
	id,
	field,
	key: "",
	op,
	value,
	values: "",
})

/** The level a log suggestion covers, and every level below it, as the bound it stays under. */
const BELOW = { debug: "info", info: "warn" } as const

/** A generated name the rule accepts: long span names are cut to the limit. */
const nameOf = (text: string): string =>
	text.length <= INGEST_RULE_LIMITS.nameLength
		? text
		: `${Str.trimEnd(Str.slice(0, INGEST_RULE_LIMITS.nameLength - 3)(text))}...`

/** The draft a suggestion link opens; `undefined` when the search carries no suggestion. */
export const draftFromSuggestion = (search: SuggestionSearch): Draft | undefined => {
	const service = search.service
	if (service === undefined || service === "") return undefined
	const keep = String(search.keep ?? 0)
	const verb = keep === "0" ? "Drop" : "Sample"
	if (search.span !== undefined && search.span !== "")
		return {
			...emptyDraft,
			name: nameOf(`${verb} ${search.span} in ${service}`),
			signals: ["traces"],
			conditions: [
				condition(1, "service_name", "eq", service),
				condition(2, "name", "eq", search.span),
			],
			nextConditionId: 3,
			keepPercent: keep,
		}
	const level = search.level === "info" ? "info" : "debug"
	return {
		...emptyDraft,
		name: nameOf(`${verb} ${level === "info" ? "info and debug" : "debug"} logs from ${service}`),
		signals: ["logs"],
		conditions: [
			condition(1, "service_name", "eq", service),
			condition(2, "severity", "lt", BELOW[level]),
		],
		nextConditionId: 3,
		keepPercent: keep,
	}
}
