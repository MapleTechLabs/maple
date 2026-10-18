import type { AlertSignalType } from "@maple/domain/http"
import { normalizeKey, parseWhereClause, quoteWhereValue, splitCsv } from "@maple/domain/where-clause"
import { createQueryDraft, type QueryBuilderQueryDraft } from "@maple/query-engine/query-builder"

import { domainThresholdToForm, formThresholdToDomain, type RuleFormState } from "./form-utils"

/** The three ways to write a rule's query. Built-in covers the five canned trace signals. */
export type SignalKind = "builtin" | "builder_query" | "raw_query"

export const signalTypeToKind = (signalType: AlertSignalType): SignalKind =>
	signalType === "builder_query" || signalType === "raw_query" ? signalType : "builtin"

/**
 * The query-builder aggregation each built-in signal evaluates. Mirrors the
 * evaluator's own table (`compileRulePlan`), so a switch lands on the same
 * numbers. Apdex has no builder aggregation.
 */
function builtinAggregation(signalType: AlertSignalType): string | null {
	switch (signalType) {
		case "error_rate":
			return "error_rate"
		case "p95_latency":
			return "p95_duration"
		case "p99_latency":
			return "p99_duration"
		case "throughput":
			return "count"
		default:
			return null
	}
}

function aggregationBuiltin(aggregation: string): AlertSignalType | null {
	switch (aggregation) {
		case "error_rate":
			return "error_rate"
		case "p95_duration":
			return "p95_latency"
		case "p99_duration":
			return "p99_latency"
		case "count":
			return "throughput"
		default:
			return null
	}
}

/** What a built-in rule filters on, as the editable query-builder draft. */
export function builtinToQueryDraft(form: RuleFormState): QueryBuilderQueryDraft {
	const base = form.queryBuilderDraft
	const clauses = ["root_only = true"]
	if (form.serviceNames.length > 0) {
		clauses.push(`service.name = ${quoteWhereValue(form.serviceNames.join(","))}`)
	}
	if (form.environments.length > 0) {
		clauses.push(`deployment.environment = ${quoteWhereValue(form.environments.join(","))}`)
	}
	for (const excluded of form.excludeServiceNames) {
		clauses.push(`service.name != ${quoteWhereValue(excluded)}`)
	}
	// A built-in rule over several services is evaluated once per service.
	const groupBy =
		form.serviceNames.length > 1 && !form.groupBy.includes("service.name")
			? ["service.name", ...form.groupBy]
			: form.groupBy
	const fresh = createQueryDraft(0)
	return {
		...fresh,
		id: base.id,
		name: base.name,
		dataSource: "traces",
		aggregation: builtinAggregation(form.signalType) ?? base.aggregation,
		whereClause: clauses.join(" AND "),
		addOns: { ...fresh.addOns, groupBy: groupBy.length > 0 },
		groupBy: groupBy.length > 0 ? [...groupBy] : [],
	}
}

export interface BuiltinFromDraft {
	readonly fields: Pick<
		RuleFormState,
		"signalType" | "serviceNames" | "excludeServiceNames" | "environments" | "groupBy"
	>
	/** Parts of the query the built-in form cannot express, dropped by the switch. */
	readonly dropped: readonly string[]
}

/** The built-in form's reading of a query-builder draft, plus what it had to drop. */
export function queryDraftToBuiltin(form: RuleFormState): BuiltinFromDraft {
	const draft = form.queryBuilderDraft
	const dropped: string[] = []
	if (draft.dataSource !== "traces") dropped.push(`${draft.dataSource} data source`)
	const mapped = draft.dataSource === "traces" ? aggregationBuiltin(draft.aggregation) : null
	if (mapped === null) dropped.push(`${draft.aggregation} aggregation`)

	const serviceNames: string[] = []
	const excludeServiceNames: string[] = []
	const environments: string[] = []
	const parsed = parseWhereClause(draft.whereClause)
	for (const warning of parsed.warnings) dropped.push(warning.clause)
	for (const clause of parsed.clauses) {
		const key = normalizeKey(clause.key)
		if (key === "root_only" && clause.operator === "=" && clause.value === "true") continue
		if (key === "service.name" && clause.operator === "=") serviceNames.push(...splitCsv(clause.value))
		else if (key === "service.name" && clause.operator === "!=") excludeServiceNames.push(clause.value)
		else if (key === "deployment.environment" && clause.operator === "=")
			environments.push(...splitCsv(clause.value))
		else dropped.push(`${clause.key} ${clause.operator} ${clause.value}`)
	}

	const groupTokens = draft.addOns.groupBy ? draft.groupBy.filter((t) => t !== "none" && t.length > 0) : []
	// Several services already split per service; the token is implied, not a choice.
	const groupBy = serviceNames.length > 1 ? groupTokens.filter((t) => t !== "service.name") : groupTokens
	// Built-in splits per named service and cannot add another split on top, so say what goes.
	const lostSplit = serviceNames.length > 0 ? groupBy.filter((t) => t !== "service.name") : []
	if (lostSplit.length > 0) dropped.push(`split by ${lostSplit.join(", ")}`)

	return {
		fields: {
			signalType: mapped ?? (form.signalType === "builder_query" ? "error_rate" : form.signalType),
			serviceNames,
			excludeServiceNames: serviceNames.length > 0 ? [] : excludeServiceNames,
			environments,
			groupBy: serviceNames.length > 0 ? [] : groupBy,
		},
		dropped,
	}
}

export interface KindSwitch {
	readonly form: RuleFormState
	/** Said once, next to the switch, when the move lost or could not carry something. */
	readonly notice: string | null
}

/**
 * Move the rule to another query mode, carrying its filters and keeping the
 * threshold's meaning: the value is converted through the stored unit, so 5%
 * on Built-in stays 5% in the builder and becomes 0.05 in SQL.
 */
export function switchSignalKind(form: RuleFormState, next: SignalKind): KindSwitch {
	if (next === signalTypeToKind(form.signalType)) return { form, notice: null }
	const moved = moveToKind(form, next)
	return { form: carryThreshold(form, moved.form), notice: moved.notice }
}

function moveToKind(form: RuleFormState, next: SignalKind): KindSwitch {
	const current = signalTypeToKind(form.signalType)
	if (next === "raw_query") return { form: { ...form, signalType: "raw_query" }, notice: null }
	if (next === "builder_query") {
		if (current !== "builtin") return { form: { ...form, signalType: "builder_query" }, notice: null }
		return {
			form: { ...form, signalType: "builder_query", queryBuilderDraft: builtinToQueryDraft(form) },
			notice:
				form.signalType === "apdex"
					? "Apdex has no query builder aggregation. Filters carried over; pick an aggregation."
					: null,
		}
	}
	if (current === "builder_query") {
		const fromQuery = queryDraftToBuiltin(form)
		return {
			form: { ...form, ...fromQuery.fields },
			notice:
				fromQuery.dropped.length > 0
					? `Built-in can't express ${fromQuery.dropped.join(", ")}. Dropped on switch.`
					: null,
		}
	}
	return {
		form: {
			...form,
			signalType: "error_rate",
			serviceNames: [],
			excludeServiceNames: [],
			environments: [],
		},
		notice: "SQL doesn't carry over to Built-in. Started from error rate on every service.",
	}
}

/** Re-express both thresholds in the moved form's unit, through the stored value. */
function carryThreshold(from: RuleFormState, to: RuleFormState): RuleFormState {
	const convert = (value: string) => {
		if (value.trim().length === 0 || !Number.isFinite(Number(value))) return value
		return domainThresholdToForm(to, formThresholdToDomain(from, value))
	}
	return { ...to, threshold: convert(from.threshold), thresholdUpper: convert(from.thresholdUpper) }
}
