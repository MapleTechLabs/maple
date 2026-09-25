/** Pieces the alert MCP tools share: parameter vocabularies, rule rows, and error mapping. */
import { Effect, Option, Schema } from "effect"
import type { AlertRuleRow } from "@maple/domain/mcp-outputs"
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
import { McpInvalidInputError } from "../tools/types"
import { doc, type ToolDoc } from "./tool-doc"

export const ALERT_SEVERITIES = AlertSeverity.literals
export const ALERT_SIGNAL_TYPES = AlertSignalType.literals
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
	destinationIds: [...rule.destinationIds],
	createdAt: rule.createdAt,
	updatedAt: rule.updatedAt,
})

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

/** The write failures that are the caller's to fix, as input errors naming the parameter. */
export const ruleWriteInputErrors = {
	"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: [`Invalid alert rule: ${error.message}`, ...error.details].join("\n"),
			}),
		),
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

/** The text a create or update returns: the rule as saved. */
export const renderRuleWrite = (title: string, rule: typeof AlertRuleRow.Type): ToolDoc => ({
	title,
	blocks: [
		doc.fields([
			["ID", rule.id],
			["Name", rule.name],
			["Service Names", rule.serviceNames.length > 0 ? rule.serviceNames.join(", ") : undefined],
			["Severity", rule.severity],
			["Signal", rule.signalType],
			["Condition", formatCondition(rule)],
			["Window", `${rule.windowMinutes}m`],
			["Enabled", rule.enabled ? "Yes" : "No"],
			["Destinations", rule.destinationIds.length],
			["Environments", rule.environments.length > 0 ? rule.environments.join(", ") : undefined],
		]),
	],
	next: [
		doc.next("get_alert_rule", { rule_id: rule.id }, "full configuration"),
		doc.next("list_alert_checks", { rule_id: rule.id }, "its evaluations once the scheduler picks it up"),
	],
})
