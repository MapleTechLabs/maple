/**
 * The error notification policy as the get and update tools report it: destinations joined to
 * their names, both id forms, and the occurrence count a new error's first notification waits for.
 */
import { Effect, Option } from "effect"
import type { ErrorNotificationPolicyDocument, OrgId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { ErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { PROMOTION_MIN_OCCURRENCES } from "@maple/backend/services/errors/error-tick-persistence"
import { doc, type ToolDoc } from "./tool-doc"

type PolicyOutput = typeof ErrorNotificationPolicyOutput.Type

export const policyOutput = Effect.fn("McpTool.errorNotificationPolicyOutput")(function* (
	orgId: OrgId,
	policy: ErrorNotificationPolicyDocument,
	tool: string,
) {
	const alerts = yield* AlertsService
	// Names are a convenience: a failed lookup must not turn an already saved write into a failure.
	const lookup = yield* alerts.listDestinations(orgId).pipe(
		Effect.map((result) => result.destinations),
		Effect.tapError((error) =>
			Effect.logWarning("Alert destination lookup failed").pipe(
				Effect.annotateLogs({ tool, error: error._tag }),
			),
		),
		Effect.option,
	)
	const byId = new Map(Option.getOrElse(lookup, () => []).map((d) => [d.id, d]))
	const output: PolicyOutput = {
		enabled: policy.enabled,
		destinationIds: policy.destinationIds,
		...(Option.isNone(lookup) ? { destinationNamesUnavailable: true } : undefined),
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

const destinationLabel = (d: PolicyOutput["destinations"][number], namesUnavailable: boolean): string =>
	d.name === null
		? `${d.id} / ${d.publicId} (${namesUnavailable ? "name unavailable" : "deleted: delivers nothing"})`
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
					: output.destinations
							.map((d) => destinationLabel(d, output.destinationNamesUnavailable === true))
							.join("; "),
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
			`A new error becomes an issue only after ${PROMOTION_MIN_OCCURRENCES} occurrences, whatever this policy says. min_occurrence_count is checked once, against the occurrences an incident opens with: a first-seen notification needs at least ${output.firstNotificationThreshold}, and an incident that opens with fewer sends none (later occurrences do not send it). For a regression the count applies as set.`,
		),
	],
})
