import { Schema, String as Str } from "effect"

// Findings the AWS connection's `security` module pulls from the account's own security services,
// stored per finding at its latest version. One vocabulary across the four services.

export const CLOUD_FINDING_SOURCES = ["guardduty", "securityhub", "inspector", "access_analyzer"] as const
export const CloudFindingSource = Schema.Literals(CLOUD_FINDING_SOURCES)
export type CloudFindingSource = typeof CloudFindingSource.Type

export const CLOUD_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const
export const CloudFindingSeverity = Schema.Literals(CLOUD_FINDING_SEVERITIES)
export type CloudFindingSeverity = typeof CloudFindingSeverity.Type

/** What the poller reads per region: a findings service, or CloudTrail for the audit log. */
export const CloudSecurityFeed = Schema.Literals([...CLOUD_FINDING_SOURCES, "cloudtrail"])
export type CloudSecurityFeed = typeof CloudSecurityFeed.Type

/** `archived`: suppressed in the service. `resolved`: the service closed it (fixed, or gone). */
export const CloudFindingStatus = Schema.Literals(["active", "archived", "resolved"])
export type CloudFindingStatus = typeof CloudFindingStatus.Type

/**
 * One service in one region, as the last poll found it. `not_enabled`: the service is off there,
 * which is the customer's choice, not a failure. `denied`: the role may not read it (an old stack).
 */
export const CloudServiceState = Schema.Literals(["enabled", "not_enabled", "denied", "failing"])
export type CloudServiceState = typeof CloudServiceState.Type

interface CloudFindingSourceSpec {
	readonly title: string
	/** What it finds, in one line for an empty state. */
	readonly summary: string
	/** Where the customer turns it on. */
	readonly enableUrl: string
}

export const CLOUD_FINDING_SOURCE_SPECS = {
	guardduty: {
		title: "GuardDuty",
		summary: "Threats: compromised credentials, crypto mining, unusual API calls and network traffic.",
		enableUrl: "https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_settingup.html",
	},
	securityhub: {
		title: "Security Hub",
		summary: "Misconfigurations against the AWS Foundational Security Best Practices.",
		enableUrl: "https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-settingup.html",
	},
	inspector: {
		title: "Inspector",
		summary: "Known vulnerabilities in EC2 instances, container images and Lambda functions.",
		enableUrl: "https://docs.aws.amazon.com/inspector/latest/user/getting_started_tutorial.html",
	},
	access_analyzer: {
		title: "IAM Access Analyzer",
		summary: "Resources shared outside the account, and unused roles, keys and permissions.",
		enableUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-getting-started.html",
	},
} as const satisfies Record<CloudFindingSource, CloudFindingSourceSpec>

/** GuardDuty's own bands over its 1.0 to 10.0 score. */
export const cloudFindingSeverityOfScore = (score: number): CloudFindingSeverity => {
	if (score >= 9) return "critical"
	if (score >= 7) return "high"
	if (score >= 4) return "medium"
	if (score >= 1) return "low"
	return "info"
}

/** Security Hub and Inspector labels; anything unrecognised (`UNTRIAGED`) reads as info. */
export const cloudFindingSeverityOfLabel = (label: string | undefined): CloudFindingSeverity => {
	switch (label === undefined ? undefined : Str.toUpperCase(label)) {
		case "CRITICAL":
			return "critical"
		case "HIGH":
			return "high"
		case "MEDIUM":
			return "medium"
		case "LOW":
			return "low"
		default:
			return "info"
	}
}

/** The console's own filter syntax for "Id equals", encoded the way its URLs carry it. */
const consoleEquals = (field: string, value: string) =>
	`${field}%3D%255Coperator%255C%253AEQUALS%255C%253A${encodeURIComponent(encodeURIComponent(value))}`

/** The finding in the AWS console: deep links where the console takes one, the findings list otherwise. */
export const cloudFindingConsoleUrl = (finding: {
	readonly source: CloudFindingSource
	readonly region: string
	readonly findingId: string
}): string => {
	const { region, findingId } = finding
	const host = Str.includes("-gov-")(region)
		? `https://console.amazonaws-us-gov.com`
		: `https://${region}.console.aws.amazon.com`
	switch (finding.source) {
		case "guardduty":
			return `${host}/guardduty/home?region=${region}#/findings?macros=current&fId=${encodeURIComponent(findingId)}`
		case "securityhub":
			return `${host}/securityhub/home?region=${region}#/findings?search=${consoleEquals("Id", findingId)}`
		case "inspector":
			return `${host}/inspector/v2/home?region=${region}#/findings/all?search=${consoleEquals("findingArn", findingId)}`
		case "access_analyzer":
			return `${host}/access-analyzer/home?region=${region}#/findings`
	}
}

/**
 * The ids telemetry may carry for a resource: itself, and for an ARN its last segment
 * (`arn:aws:ec2:...:instance/i-0abc` is `i-0abc` on `host.id`, a Lambda ARN ends in `faas.name`).
 */
export const cloudResourceIdCandidates = (resourceId: string): ReadonlyArray<string> => {
	const id = Str.trim(resourceId)
	if (id === "") return []
	if (!Str.startsWith("arn:")(id)) return [id]
	const segments = Str.split(Str.includes("/")(id) ? "/" : ":")(id)
	const tail = segments[segments.length - 1] ?? ""
	return tail === "" || tail === id ? [id] : [id, tail]
}
