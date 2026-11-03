import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { GetErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { policyOutput, renderPolicy } from "../lib/error-notification-policy"
import { persistenceFailed } from "./error-issue-shared"

export function registerGetErrorNotificationPolicyTool(server: McpToolRegistrar) {
	server.define({
		name: "get_error_notification_policy",
		title: "Get Error Notification Policy",
		description:
			"Read the org-wide error notification policy: whether it is on, which alert destinations it delivers to (name, UUID and REST id), which events notify, min_occurrence_count and the occurrence count a new error's first notification actually waits for. update_error_notification_policy changes it.",
		parameters: Schema.Struct({}),
		output: GetErrorNotificationPolicyOutput,
		hints: { readOnly: true },
		phrases: ["Reading the notification policy"],
		handler: Effect.fn("McpTool.getErrorNotificationPolicy")(function* () {
			const tenant = yield* CurrentMcpTenant
			const policies = yield* ErrorPolicyService
			const policy = yield* policies
				.getNotificationPolicy(tenant.orgId)
				.pipe(
					Effect.catchTag(
						"@maple/http/errors/ErrorPersistenceError",
						persistenceFailed("get_error_notification_policy"),
					),
				)
			return yield* policyOutput(tenant.orgId, policy, "get_error_notification_policy")
		}),
		render: (output) => renderPolicy("Error notification policy", output),
	})
}
