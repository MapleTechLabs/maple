import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { UpdateErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { persistenceFailed, validationFailed } from "./error-issue-shared"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { AlertDestinationId, AlertSeverity, ErrorNotificationPolicyUpsertRequest } from "@maple/domain/http"

const decodeDestinationId = Schema.decodeUnknownEffect(AlertDestinationId)
const decodePatch = Schema.decodeEffect(ErrorNotificationPolicyUpsertRequest)

const yesNo = (value: boolean): string => (value ? "yes" : "no")

export function registerUpdateErrorNotificationPolicyTool(server: McpToolRegistrar) {
	server.define({
		name: "update_error_notification_policy",
		description:
			"Configure the org-wide error notification policy. Controls whether incidents (first-seen, regression, auto-resolve) dispatch to alert destinations. Omit a field to leave it unchanged.",
		parameters: Schema.Struct({
			enabled: P.optionalFlag("Enable notifications overall"),
			destination_ids: P.optionalList("Alert destination IDs to notify. Pass an empty list to clear."),
			notify_on_first_seen: P.optionalFlag(
				"Notify on the first-ever occurrence of an error fingerprint",
			),
			notify_on_regression: P.optionalFlag("Notify when a resolved issue re-occurs"),
			notify_on_resolve: P.optionalFlag(
				"Notify when an incident is auto-resolved after the silence window",
			),
			min_occurrence_count: P.optionalNumber(
				"Only notify when the opening occurrence count meets this threshold (default 1)",
			),
			severity: P.optionalOneOf(AlertSeverity.literals, "Severity label attached to notifications"),
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
					: yield* Effect.forEach(params.destination_ids, (token) =>
							decodeDestinationId(token).pipe(
								Effect.mapError(
									() =>
										new McpInvalidInputError({
											message: `Invalid alert destination ID: ${token}`,
											parameter: "destination_ids",
										}),
								),
							),
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
						"@maple/http/errors/ErrorValidationError": validationFailed(),
					}),
				)

			return {
				enabled: policy.enabled,
				destinationIds: policy.destinationIds,
				notifyOnFirstSeen: policy.notifyOnFirstSeen,
				notifyOnRegression: policy.notifyOnRegression,
				notifyOnResolve: policy.notifyOnResolve,
				minOccurrenceCount: policy.minOccurrenceCount,
				severity: policy.severity,
			}
		}),
		render: (output) => ({
			title: "Error notification policy updated",
			blocks: [
				doc.fields([
					["Enabled", yesNo(output.enabled)],
					[
						"Destinations",
						output.destinationIds.length > 0 ? output.destinationIds.join(", ") : "—",
					],
					["First seen", yesNo(output.notifyOnFirstSeen)],
					["Regression", yesNo(output.notifyOnRegression)],
					["Resolve", yesNo(output.notifyOnResolve)],
					["Min occurrence", output.minOccurrenceCount],
					["Severity", output.severity],
				]),
			],
		}),
	})
}
