import type { CloudFindingSeverity, CloudFindingStatus } from "@maple/domain/cloud-security"
import { DateTime, Option, Schema } from "effect"
import type { CloudFindingWrite } from "./CloudSecurityStore"

// A finding as one of the four services reported it, in the stored shape. Shared by the poller's
// readers and the EventBridge receiver, so it imports no AWS SDK.

/** A finding as a reader saw it, before the connection's columns are stamped on. */
export type FindingRead = Omit<
	CloudFindingWrite,
	"orgId" | "connectionId" | "accountId" | "region" | "source"
>

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

/** A finding in the stored shape. None when the service gave it no time at all. */
export const readFinding = (finding: {
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
}): Option.Option<FindingRead> => {
	const updatedAt = finding.updatedAt ?? finding.lastSeenAt ?? finding.firstSeenAt
	if (updatedAt === undefined) return Option.none()
	return Option.some({
		findingId: finding.findingId,
		type: finding.type,
		title: finding.title === undefined || finding.title === "" ? finding.type : finding.title,
		description:
			finding.description === undefined || finding.description === "" ? null : finding.description,
		severity: finding.severity,
		status: finding.status,
		resourceType: finding.resourceType ?? "",
		resourceId: finding.resourceId ?? "",
		resourceName: finding.resourceName ?? null,
		occurrences: finding.occurrences ?? 1,
		firstSeenAt: finding.firstSeenAt ?? updatedAt,
		lastSeenAt: finding.lastSeenAt ?? updatedAt,
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
