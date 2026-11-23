import type { V2IngestRule, V2IngestRuleSuggestion } from "@maple/domain/http/v2"
import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Order } from "effect"
import { suggestedRuleHref } from "../ingest-rule/suggested"
import type { Model } from "./ingest-rules"
import type { Message } from "./message"

// Under the rule list: rules the last 24 hours of stored data suggest, each a link to a
// prefilled editor. Hidden when there are none or they did not load.

type H = HtmlBuilder<Message>

/** The editor link for one suggestion, locked for a viewer who cannot manage rules. */
export type SuggestionLink = (
	h: H,
	options: Readonly<{ href: string; variant?: "outline"; ariaLabel?: string }>,
	children: ReadonlyArray<Html | string>,
) => Html

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`

const titleOf = (suggestion: V2IngestRuleSuggestion): string =>
	suggestion.signal === "traces"
		? `${suggestion.span_name ?? "Spans"} in ${suggestion.service_name}`
		: `${suggestion.level === "info" ? "Info and debug" : "Debug"} logs from ${suggestion.service_name}`

/** The button's text: what the suggested rule does. */
const action = (suggestion: V2IngestRuleSuggestion): string =>
	suggestion.keep_percent === 0 ? "Drop" : `Sample ${suggestion.keep_percent}%`

const reasonOf = (suggestion: V2IngestRuleSuggestion): string => {
	const ofSignal = `${percent(suggestion.share)} of stored ${suggestion.signal === "logs" ? "logs" : "spans"}`
	switch (suggestion.reason) {
		case "debug_logs":
			return `Debug logs, ${ofSignal}`
		case "health_checks":
			return `Health-check spans, ${ofSignal}`
		case "info_logs":
			return `Logs below warn, ${ofSignal}`
	}
}

const suggestionRow = (h: H, link: SuggestionLink, suggestion: V2IngestRuleSuggestion): Html =>
	hstack(h, { gap: "3", align: "center", className: stripClass("row") }, [
		vstack(h, { gap: "1", shrink: true, grow: true }, [
			truncatedText(h, { text: titleOf(suggestion), className: "text-sm" }),
			typography(h, { size: "2xs", tone: "muted" }, [reasonOf(suggestion)]),
		]),
		vstack(h, { gap: "1", className: "hidden w-36 shrink-0 sm:flex" }, [
			typography(h, { size: "xs", numeric: true }, [
				`${formatStorageBytes(suggestion.saved_bytes)} a day`,
			]),
			typography(h, { size: "2xs", tone: "muted", numeric: true }, [
				`${formatNumber(suggestion.records)} records`,
			]),
		]),
		hstack(h, { justify: "end", className: "w-24 shrink-0" }, [
			link(
				h,
				{
					variant: "outline",
					href: suggestedRuleHref(suggestion),
					ariaLabel: `${action(suggestion)}: ${titleOf(suggestion)}`,
				},
				[action(suggestion)],
			),
		]),
	])

/** The conditions a suggestion's rule would have, as `field op value` keys in any order. */
const conditionKeys = (conditions: ReadonlyArray<{ field: string; op: string; value?: string }>) =>
	Arr.sort(
		Arr.map(conditions, (condition) => `${condition.field} ${condition.op} ${condition.value ?? ""}`),
		Order.String,
	)

const suggestedKeys = (suggestion: V2IngestRuleSuggestion) =>
	conditionKeys([
		{ field: "service_name", op: "eq", value: suggestion.service_name },
		suggestion.span_name === null
			? { field: "severity", op: "lt", value: suggestion.level === "info" ? "warn" : "info" }
			: { field: "name", op: "eq", value: suggestion.span_name },
	])

/**
 * An enabled drop rule already does what the suggestion would: the same conditions, no more and
 * no fewer, keeping no more than the suggestion keeps. Anything looser or stricter is not covered.
 */
const isCovered = (rules: ReadonlyArray<V2IngestRule>, suggestion: V2IngestRuleSuggestion): boolean => {
	const wanted = suggestedKeys(suggestion)
	return Arr.some(
		rules,
		(rule) =>
			rule.enabled &&
			rule.action.type === "drop" &&
			rule.action.keep_percent <= suggestion.keep_percent &&
			rule.signals.includes(suggestion.signal) &&
			Arr.join(conditionKeys(rule.conditions), "\n") === Arr.join(wanted, "\n"),
	)
}

export const ruleSuggestions = (h: H, model: Model, link: SuggestionLink): ReadonlyArray<Html> => {
	if (!AsyncData.isSuccess(model.rules) || !AsyncData.isSuccess(model.suggestions)) return []
	const rules = model.rules.data
	const open = Arr.filter(model.suggestions.data.data, (suggestion) => !isCovered(rules, suggestion))
	if (open.length === 0) return []
	return [
		h.div(
			[h.AriaLabel("Suggested rules"), h.Role("group")],
			[
				hstack(h, { gap: "3", align: "center", className: stripClass("head", "border-t py-1.5") }, [
					eyebrow(h, { variant: "mono", as: "div" }, ["Suggested from the last 24 hours"]),
				]),
				...Arr.map(open, (suggestion) => suggestionRow(h, link, suggestion)),
			],
		),
	]
}
