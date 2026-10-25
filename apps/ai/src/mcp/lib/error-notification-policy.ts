/**
 * The error notification policy as the get and update tools report it: destinations joined to
 * their names, both id forms, and the occurrence count a new error's first notification waits for.
 */
import { Effect } from "effect"
import type { ErrorNotificationPolicyDocument, OrgId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { ErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { PROMOTION_MIN_OCCURRENCES } from "@maple/backend/services/errors/error-tick-persistence"
import { toMcpHttpError } from "./map-http-error"
import { doc, type ToolDoc } from "./tool-doc"

type PolicyOutput = typeof ErrorNotificationPolicyOutput.Type

export const policyOutput = Effect.fn("McpTool.errorNotificationPolicyOutput")(function* (
	orgId: OrgId,
	policy: ErrorNotificationPolicyDocument,
	tool: string,
) {
	const alerts = yield* AlertsService
	const { destinations } = yield* alerts.listDestinations(orgId).pipe(Effect.mapError(toMcpHttpError(tool)))
	const byId = new Map(destinations.map((d) => [d.id, d]))
	const output: PolicyOutput = {
		enabled: policy.enabled,
		destinationIds: policy.destinationIds,
		destinations: policy.destinationIds.map((id) => {
			const found = byId.get(id)
			return {
				id,
				publicId: encodePublicId(PublicIdPrefixes.alertDestination, id),
				name: found?.name ?? null,
				type: found?.type ?? null,
				enabled: found?.enabled ?? false,
			}
		}),
		notifyOnFirstSeen: policy.notifyOnFirstSeen,
		notifyOnRegression: policy.notifyOnRegression,
		notifyOnResolve: policy.notifyOnResolve,
		minOccurrenceCount: policy.minOccurrenceCount,
		firstNotificationThreshold: Math.max(PROMOTION_MIN_OCCURRENCES, policy.minOccurrenceCount),
		severity: policy.severity,
		updatedAt: policy.updatedAt,
		updatedBy: policy.updatedBy,
	}
	return output
})

const yesNo = (value: boolean): string => (value ? "yes" : "no")

const destinationLabel = (d: PolicyOutput["destinations"][number]): string =>
	d.name === null
		? `${d.id} / ${d.publicId} (deleted: delivers nothing)`
		: `${d.name} (${d.type}${d.enabled ? "" : ", disabled"}): ${d.id} / ${d.publicId}`

/** The policy as a field list, with what min_occurrence_count does and does not control. */
export const renderPolicy = (title: string, output: PolicyOutput): ToolDoc => ({
	title,
	blocks: [
		doc.fields([
			["Enabled", yesNo(output.enabled)],
			[
				"Destinations",
				output.destinations.length === 0
					? "none: nothing is delivered"
					: output.destinations.map(destinationLabel).join("; "),
			],
			["First seen", yesNo(output.notifyOnFirstSeen)],
			["Regression", yesNo(output.notifyOnRegression)],
			["Resolve", yesNo(output.notifyOnResolve)],
			["Min occurrence count", output.minOccurrenceCount],
			["Severity", output.severity],
			[
				"Last changed",
				output.updatedBy === "system"
					? "never (defaults)"
					: `${output.updatedAt} by ${output.updatedBy}`,
			],
		]),
		doc.text(
			`A new error becomes an issue only after ${PROMOTION_MIN_OCCURRENCES} occurrences, whatever this policy says, so its first-seen notification goes out at ${output.firstNotificationThreshold} occurrences. min_occurrence_count is compared with the occurrences an incident opens with: it raises that bar above ${PROMOTION_MIN_OCCURRENCES}, and for a regression it applies as set.`,
		),
	],
})
