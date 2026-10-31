/** Pieces the alert MCP tools share: parameter vocabularies, rule rows, and error mapping. */
import { Effect, Option, Schema } from "effect"
import type { AlertRuleFirstEvaluation, AlertRuleRow } from "@maple/domain/mcp-outputs"
import {
	AlertCheckStatus,
	AlertComparator,
	AlertDestinationType,
	AlertIncidentStatus,
	AlertRuleId,
	AlertSeverity,
	AlertSignalType,
	type AlertRuleDocument,
	type AlertRuleDestinationNotFoundError,
	type AlertRuleNotFoundError,
	type AlertValidationError,
} from "@maple/domain/http"
import { QueryEngineAlertReducer } from "@maple/domain"
import { rawAlertSampleCountWarning } from "@maple/domain/raw-sql"
import { alertRuleIntervalMinutes } from "@maple/query-engine/datetime"
import { McpInvalidInputError } from "../tools/types"
import { doc, type ToolDoc } from "./tool-doc"

export const ALERT_SEVERITIES = AlertSeverity.literals
/** `uptime` rules are made and edited through uptime monitors, so the rule tools never offer it. */
export const ALERT_SIGNAL_TYPES = AlertSignalType.pick([
	"error_rate",
	"p95_latency",
	"p99_latency",
	"apdex",
	"throughput",
	"builder_query",
	"raw_query",
]).literals
/** The range comparators need `thresholdUpper`, which the tools do not take. */
export const ALERT_COMPARATORS = AlertComparator.pick(["gt", "gte", "lt", "lte", "eq", "neq"]).literals
export const ALERT_REDUCERS = QueryEngineAlertReducer.literals
export const ALERT_INCIDENT_STATUSES = AlertIncidentStatus.literals
export const ALERT_CHECK_STATUSES = AlertCheckStatus.literals
export const ALERT_DESTINATION_TYPES = AlertDestinationType.literals

export const comparatorLabel = (comparator: string): string => {
	switch (comparator) {
		case "gt":
			return ">"
		case "gte":
			return ">="
		case "lt":
			return "<"
		case "lte":
			return "<="
		case "eq":
			return "="
		case "neq":
			return "!="
		default:
			return comparator
	}
}

export const formatCondition = (rule: {
	readonly comparator: string
	readonly threshold: number
	readonly thresholdUpper?: number | null | undefined
}): string =>
	rule.thresholdUpper != null && (rule.comparator === "between" || rule.comparator === "not_between")
		? `${rule.comparator} ${rule.threshold} and ${rule.thresholdUpper}`
		: `${comparatorLabel(rule.comparator)} ${rule.threshold}`

export const toAlertRuleRow = (rule: AlertRuleDocument): typeof AlertRuleRow.Type => ({
	id: rule.id,
	name: rule.name,
	enabled: rule.enabled,
	severity: rule.severity,
	serviceNames: [...rule.serviceNames],
	environments: [...rule.environments],
	signalType: rule.signalType,
	comparator: rule.comparator,
	threshold: rule.threshold,
	windowMinutes: rule.windowMinutes,
	evaluationIntervalMinutes: rule.evaluationIntervalMinutes,
	slowedIntervalMinutes: rule.slowedIntervalMinutes,
	destinationIds: [...rule.destinationIds],
	createdAt: rule.createdAt,
	updatedAt: rule.updatedAt,
})

interface RuleCadence {
	readonly windowMinutes: number
	readonly evaluationIntervalMinutes: number | null
	readonly slowedIntervalMinutes: number | null
}

/** How often the rule is checked, and whether that was picked, derived or slowed down. */
export const formatCheckInterval = (rule: RuleCadence): string => {
	const base = alertRuleIntervalMinutes({ ...rule, slowedIntervalMinutes: null })
	const effective = alertRuleIntervalMinutes(rule)
	if (effective !== base) return `every ${effective}m (slowed down from ${base}m)`
	return rule.evaluationIntervalMinutes === null
		? `every ${effective}m (derived from the window)`
		: `every ${effective}m`
}

/** Why a slowed rule runs less often than configured, and how to undo it. */
export const slowedNotice = (rule: RuleCadence): ReadonlyArray<string> =>
	rule.slowedIntervalMinutes === null
		? []
		: [
				`The scheduler slowed this rule down to every ${alertRuleIntervalMinutes(rule)}m after its query hit its time or memory limit 3 checks in a row. Editing the rule resets that; make the query cheaper first (preview_alert_rule times it).`,
			]

/** How a rule covers a service: named in its scope, unscoped (every service), or a raw query mentioning it. */
export type RuleServiceMatch = "scoped" | "all_services" | "raw_query_mention"

export const ruleServiceMatch = (
	rule: Pick<
		AlertRuleDocument,
		"serviceNames" | "excludeServiceNames" | "signalType" | "rawQuerySql" | "name"
	>,
	service: string,
): RuleServiceMatch | undefined => {
	if (rule.serviceNames.includes(service)) return "scoped"
	if (rule.excludeServiceNames.includes(service)) return undefined
	if (rule.signalType === "raw_query") {
		const needle = service.toLowerCase()
		const haystack = `${rule.rawQuerySql ?? ""}\n${rule.name}`.toLowerCase()
		return haystack.includes(needle) ? "raw_query_mention" : undefined
	}
	return rule.serviceNames.length === 0 ? "all_services" : undefined
}

const decodeAlertRuleId = Schema.decodeUnknownOption(AlertRuleId)

export const ruleNotFound = (ruleId: string) =>
	new McpInvalidInputError({
		message: `Alert rule not found: ${ruleId}. Use list_alert_rules to find available rule IDs.`,
		parameter: "rule_id",
	})

/** A caller-supplied rule id, as the branded id. One that does not parse cannot exist either. */
export const parseRuleId = (ruleId: string) =>
	Option.match(decodeAlertRuleId(ruleId), {
		onNone: () => Effect.fail(ruleNotFound(ruleId)),
		onSome: (id) => Effect.succeed(id),
	})

/**
 * An invalid rule as the model reads it: the message and each detail once. A
 * message that already folds in every detail is dropped as a repeat; any other
 * message names the failure the details only qualify, so it stays.
 */
export const invalidRuleInput = (error: AlertValidationError) => {
	const repeatsDetails =
		error.details.length > 0 && error.details.every((detail) => error.message.includes(detail))
	return new McpInvalidInputError({
		message: [
			repeatsDetails ? "Invalid alert rule:" : `Invalid alert rule: ${error.message}`,
			...error.details.map((detail) => `- ${detail}`),
		].join("\n"),
	})
}

/** The write failures that are the caller's to fix, as input errors naming the parameter. */
export const ruleWriteInputErrors = {
	"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
		Effect.fail(invalidRuleInput(error)),
	"@maple/http/errors/AlertRuleDestinationNotFoundError": (error: AlertRuleDestinationNotFoundError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: `Alert destination not found: ${error.destinationId}. Use list_alert_destinations to find destination IDs.`,
				parameter: "destination_ids",
			}),
		),
}

/** A rule that vanished between the read and the write: the caller's id no longer exists. */
export const ruleNotFoundFromError = (error: AlertRuleNotFoundError) =>
	Effect.fail(ruleNotFound(error.ruleId))

/** Saved-but-suspicious configuration worth telling the caller about. */
export const ruleConfigWarnings = (rule: {
	readonly signalType: string
	readonly rawQuerySql: string | null
	readonly minimumSampleCount: number
}): ReadonlyArray<string> => {
	if (rule.signalType !== "raw_query" || rule.rawQuerySql === null) return []
	const warning = rawAlertSampleCountWarning(rule.rawQuerySql, rule.minimumSampleCount)
	return warning === null ? [] : [warning]
}

const evaluationBlocks = (
	evaluation: typeof AlertRuleFirstEvaluation.Type | undefined,
	intervalMinutes: number,
) => {
	if (evaluation === undefined) return []
	const when =
		evaluation.nextEvaluationAt === null
			? "The rule is disabled, so the scheduler will not evaluate it."
			: `First scheduled evaluation by ${evaluation.nextEvaluationAt.slice(0, 19)}Z (every ${intervalMinutes}m after), no need to poll list_alert_checks before then.`
	const now =
		evaluation.previewError !== undefined
			? `A preview of the latest window failed: ${evaluation.previewError}. Run preview_alert_rule to see what it observes.`
			: evaluation.current.length === 0
				? "A preview of the latest window returned no series."
				: undefined
	return [
		doc.text(now === undefined ? when : `${when}\n${now}`),
		...(evaluation.current.length === 0
			? []
			: [
					doc.table(
						["Group", "Latest window", "Verdict", "Value", "Samples"],
						evaluation.current
							.slice(0, 10)
							.map((c) => [
								c.groupKey,
								c.window.slice(0, 19),
								c.status === "skipped" ? `skipped (${c.skipReason ?? "?"})` : c.status,
								c.value === null ? "-" : String(c.value),
								String(c.sampleCount),
							]),
					),
				]),
	]
}

/** The text a bulk update returns: which rules changed. */
export const renderBulkRuleWrite = (
	rules: ReadonlyArray<typeof AlertRuleRow.Type>,
	warnings: ReadonlyArray<string> = [],
): ToolDoc => ({
	title: `Updated ${rules.length} Alert Rules`,
	...(warnings.length > 0 ? { notices: warnings } : undefined),
	blocks: [
		doc.table(
			["ID", "Name", "Enabled", "Destinations"],
			rules.map((r) => [r.id, r.name, r.enabled ? "Yes" : "No", String(r.destinationIds.length)]),
		),
	],
	next: rules
		.slice(0, 1)
		.map((r) => doc.next("get_alert_rule", { rule_id: r.id }, "check one of the updated rules")),
})

/** The text a create or update returns: the rule as saved. */
export const renderRuleWrite = (
	title: string,
	rule: typeof AlertRuleRow.Type,
	warnings: ReadonlyArray<string> = [],
	evaluation?: typeof AlertRuleFirstEvaluation.Type,
): ToolDoc => {
	const notices = [...warnings, ...slowedNotice(rule)]
	return {
		title,
		...(notices.length > 0 ? { notices } : undefined),
		blocks: [
			...evaluationBlocks(evaluation, alertRuleIntervalMinutes(rule)),
			doc.fields([
				["ID", rule.id],
				["Name", rule.name],
				["Service Names", rule.serviceNames.length > 0 ? rule.serviceNames.join(", ") : undefined],
				["Severity", rule.severity],
				["Signal", rule.signalType],
				["Condition", formatCondition(rule)],
				["Window", `${rule.windowMinutes}m, checked ${formatCheckInterval(rule)}`],
				["Enabled", rule.enabled ? "Yes" : "No"],
				["Destinations", rule.destinationIds.length],
				["Environments", rule.environments.length > 0 ? rule.environments.join(", ") : undefined],
			]),
		],
		next: [
			doc.next("get_alert_rule", { rule_id: rule.id }, "full configuration"),
			doc.next(
				"preview_alert_rule",
				{ rule_id: rule.id },
				"replay it over the last day to see what it would have done",
			),
			doc.next(
				"list_alert_checks",
				{ rule_id: rule.id },
				"its evaluations once the scheduler picks it up",
			),
		],
	}
}
