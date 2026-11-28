import type { CloudFindingSeverity, CloudFindingStatus } from "@maple/domain/cloud-security"
import { DateTime, Option, Schema, String as Str } from "effect"
import type { CloudFindingBody } from "./CloudSecurityStore"

// A finding as one of the four services reported it, in the stored shape. Shared by the poller's
// readers and the EventBridge receiver, so it imports no AWS SDK.

/** A finding as a reader saw it, before the connection's columns are stamped on. */
export type FindingRead = CloudFindingBody

/** A finding's service record above this many bytes keeps only its columns. */
const DETAIL_LIMIT_BYTES = 16 * 1024
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const msOf = (value: string | Date | undefined): number | undefined =>
	value === undefined
		? undefined
		: Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.toEpochMillis))

/** The service's record, unless it is too large to keep. */
const detailOf = (detail: Record<string, unknown>): Record<string, unknown> | null =>
	new TextEncoder().encode(encodeJson(detail)).length > DETAIL_LIMIT_BYTES ? null : detail

/** A finding id longer than this is not stored: cut short, it could be another finding's id. */
export const FINDING_ID_MAX_CHARS = 1024
export const RESOURCE_ID_MAX_CHARS = 1024
export const TITLE_MAX_CHARS = 512
export const DESCRIPTION_MAX_CHARS = 4096
/** The type, the resource type and the resource name. */
export const LABEL_MAX_CHARS = 512
const OCCURRENCES_MAX = 2_147_483_647

/** `value` cut to `max` UTF-16 units, never through the middle of a surrogate pair. */
const truncate = (value: string, max: number): string => {
	if (value.length <= max) return value
	const last = Option.getOrElse(Str.charCodeAt(value, max - 1), () => 0)
	return Str.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)(value)
}

/** A count as the int4 column holds it: a whole number from 1 up. */
const occurrencesOf = (count: number | undefined): number =>
	count === undefined || !Number.isFinite(count)
		? 1
		: Math.min(Math.max(Math.trunc(count), 1), OCCURRENCES_MAX)

/**
 * A finding in the stored shape, its text cut to the column limits. None when the service gave it
 * no time at all, or an id too long to keep. No time is later than `nowMs`: a version dated ahead
 * would outrank every later one until the clock caught up with it.
 */
export const readFinding = (
	finding: {
		readonly findingId: string
		readonly type: string
		readonly title: string | undefined
		readonly description: string | undefined
		readonly severity: CloudFindingSeverity
		readonly status: CloudFindingStatus
		readonly resourceType: string | undefined
		readonly resourceId: string | undefined
		readonly resourceName: string | undefined
		readonly occurrences: number | undefined
		readonly firstSeenAt: number | undefined
		readonly lastSeenAt: number | undefined
		readonly updatedAt: number | undefined
		readonly detail: Record<string, unknown>
	},
	nowMs: number,
): Option.Option<FindingRead> => {
	const reported = finding.updatedAt ?? finding.lastSeenAt ?? finding.firstSeenAt
	if (reported === undefined || finding.findingId.length > FINDING_ID_MAX_CHARS) return Option.none()
	const updatedAt = Math.min(reported, nowMs)
	const type = truncate(finding.type, LABEL_MAX_CHARS)
	return Option.some({
		findingId: finding.findingId,
		type,
		title:
			finding.title === undefined || finding.title === ""
				? type
				: truncate(finding.title, TITLE_MAX_CHARS),
		description:
			finding.description === undefined || finding.description === ""
				? null
				: truncate(finding.description, DESCRIPTION_MAX_CHARS),
		severity: finding.severity,
		status: finding.status,
		resourceType: truncate(finding.resourceType ?? "", LABEL_MAX_CHARS),
		resourceId: truncate(finding.resourceId ?? "", RESOURCE_ID_MAX_CHARS),
		resourceName:
			finding.resourceName === undefined ? null : truncate(finding.resourceName, LABEL_MAX_CHARS),
		occurrences: occurrencesOf(finding.occurrences),
		firstSeenAt: Math.min(finding.firstSeenAt ?? updatedAt, nowMs),
		lastSeenAt: Math.min(finding.lastSeenAt ?? updatedAt, nowMs),
		providerUpdatedAt: updatedAt,
		detail: detailOf(finding.detail),
	})
}

// Security Hub

/** Security Hub also carries GuardDuty, Inspector and Access Analyzer findings, read from them directly. */
export const AGGREGATED_PRODUCTS = ["GuardDuty", "Inspector", "IAM Access Analyzer"]

export const securityHubStatus = (finding: {
	readonly recordState: string | undefined
	readonly complianceStatus: string | undefined
	readonly workflowStatus: string | undefined
}): CloudFindingStatus => {
	if (finding.recordState === "ARCHIVED") return "resolved"
	if (finding.complianceStatus === "PASSED") return "resolved"
	if (finding.workflowStatus === "RESOLVED") return "resolved"
	if (finding.workflowStatus === "SUPPRESSED") return "archived"
	return "active"
}

// Inspector

export const inspectorStatus = (status: string | undefined): CloudFindingStatus =>
	status === "CLOSED" ? "resolved" : status === "SUPPRESSED" ? "archived" : "active"

// IAM Access Analyzer

export const accessAnalyzerTitle = (findingType: string): string => {
	switch (findingType) {
		case "ExternalAccess":
			return "Shared outside the account"
		case "InternalAccess":
			return "Shared within the organization"
		case "UnusedIAMRole":
			return "Unused IAM role"
		case "UnusedIAMUserAccessKey":
			return "Unused access key"
		case "UnusedIAMUserPassword":
			return "Unused console password"
		case "UnusedPermission":
			return "Unused permissions"
		default:
			return findingType
	}
}

export const accessAnalyzerSeverity = (findingType: string): CloudFindingSeverity =>
	findingType === "ExternalAccess" ? "high" : findingType === "InternalAccess" ? "medium" : "low"

export const accessAnalyzerStatus = (status: string | undefined): CloudFindingStatus =>
	status === "RESOLVED" ? "resolved" : status === "ARCHIVED" ? "archived" : "active"
