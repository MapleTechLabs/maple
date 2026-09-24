import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DeleteAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { parseRuleId, ruleNotFoundFromError } from "../lib/alert-rules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerDeleteAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "delete_alert_rule",
		description:
			"Permanently delete an alert rule together with its incident history, delivery events and evaluation state. " +
			"Irreversible; requires confirm=true. Ids from list_alert_rules.",
		parameters: Schema.Struct({
			rule_id: P.text("Alert rule ID"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		output: DeleteAlertRuleOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an alert rule"],
		handler: Effect.fn("McpTool.deleteAlertRule")(function* (params) {
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_alert_rule with confirm=true to permanently delete rule ${params.rule_id} and its incident history.`,
					parameter: "confirm",
				})
			}

			const ruleId = yield* parseRuleId(params.rule_id)
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertRulesService

			const result = yield* alerts.deleteRule(tenant.orgId, tenant.roles, ruleId).pipe(
				Effect.catchTags({
					"@maple/http/errors/AlertRuleNotFoundError": ruleNotFoundFromError,
					"@maple/http/errors/AlertForbiddenError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}`,
								pipeName: "delete_alert_rule",
								cause: error,
							}),
						),
					"@maple/http/errors/AlertPersistenceError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}`,
								pipeName: "delete_alert_rule",
								cause: error,
							}),
						),
				}),
			)

			return { id: result.id }
		}),
		render: (output) => ({
			title: "Alert Rule Deleted",
			blocks: [doc.fields([["ID", output.id]])],
			next: [doc.next("list_alert_rules", {}, "the remaining rules")],
		}),
	})
}
