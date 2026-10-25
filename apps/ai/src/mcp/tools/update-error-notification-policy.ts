import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { UpdateErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { policyOutput, renderPolicy } from "../lib/error-notification-policy"
import { persistenceFailed } from "./error-issue-shared"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { AlertSeverity, ErrorNotificationPolicyUpsertRequest } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"

const decodePatch = Schema.decodeEffect(ErrorNotificationPolicyUpsertRequest)

export function registerUpdateErrorNotificationPolicyTool(server: McpToolRegistrar) {
	server.define({
		name: "update_error_notification_policy",
		title: "Update Error Notification Policy",
		description:
			"Configure the org-wide error notification policy: whether error incidents (first seen, regression, auto-resolve) are delivered to alert destinations, and which ones. Org admins only. Omit a field to leave it unchanged; get_error_notification_policy reads the current policy. A new error becomes an issue (and can notify) only after 3 occurrences; min_occurrence_count cannot lower that.",
		parameters: Schema.Struct({
			enabled: P.optionalFlag("Enable notifications overall"),
			destination_ids: P.optionalResourceIdList(
				"alertDestination",
				"Alert destinations (from list_alert_destinations) to deliver to, replacing the current ones. Pass [] to clear them",
			),
			notify_on_first_seen: P.optionalFlag(
				"Notify when a new error becomes an issue (after its 3rd occurrence)",
			),
			notify_on_regression: P.optionalFlag("Notify when a resolved issue re-occurs"),
			notify_on_resolve: P.optionalFlag(
				"Notify when an incident is auto-resolved after the silence window",
			),
			min_occurrence_count: P.optionalNumber(
				"Only notify when an incident opens with at least this many occurrences. New errors already need 3 to become an issue, so values of 3 or less only affect regressions",
			),
			severity: P.optionalOneOf(AlertSeverity.literals, "Severity label carried on the notifications"),
		}),
		output: UpdateErrorNotificationPolicyOutput,
		// Setting the same fields again changes nothing; omitted fields are left as they are.
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating the notification policy"],
		handler: Effect.fn("McpTool.updateErrorNotificationPolicy")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const policies = yield* ErrorPolicyService

			const destinationIds =
				params.destination_ids === undefined
					? undefined
					: yield* Effect.forEach(
							params.destination_ids,
							P.decodeResourceId("alertDestination", "destination_ids"),
						)

			const patch = yield* decodePatch({
				...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
				...(destinationIds === undefined ? undefined : { destinationIds }),
				...(params.notify_on_first_seen === undefined
					? undefined
					: { notifyOnFirstSeen: params.notify_on_first_seen }),
				...(params.notify_on_regression === undefined
					? undefined
					: { notifyOnRegression: params.notify_on_regression }),
				...(params.notify_on_resolve === undefined
					? undefined
					: { notifyOnResolve: params.notify_on_resolve }),
				...(params.min_occurrence_count === undefined
					? undefined
					: { minOccurrenceCount: params.min_occurrence_count }),
				...(params.severity === undefined ? undefined : { severity: params.severity }),
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({
							message: `Invalid notification policy: ${error.message}`,
							parameter: "min_occurrence_count",
						}),
				),
			)

			const policy = yield* policies
				.upsertNotificationPolicy(tenant.orgId, tenant.userId, tenant.roles, patch)
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorForbiddenError": (error) =>
							Effect.fail(
								new McpUnavailableError({ message: error.message, capability: "org_admin" }),
							),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed(
							"update_error_notification_policy",
						),
						"@maple/http/errors/ErrorNotificationDestinationNotFoundError": (error) =>
							Effect.fail(
								new McpInvalidInputError({
									message: `No alert destination ${error.destinationIds
										.map(
											(id) =>
												`${id} (${encodePublicId(PublicIdPrefixes.alertDestination, id)})`,
										)
										.join(
											", ",
										)} in this org. list_alert_destinations lists them. Nothing was changed.`,
									parameter: "destination_ids",
								}),
							),
					}),
				)

			return yield* policyOutput(tenant.orgId, policy, "update_error_notification_policy")
		}),
		render: (output) => renderPolicy("Error notification policy updated", output),
	})
}
