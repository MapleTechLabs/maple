import {
	AwsAccountId,
	AwsConnectionId,
	AwsRegion,
	GcpConnectorId,
	GcpLocation,
	GcpProjectId,
	GcpResourceNumber,
} from "@maple/primitives"
import { Array as Arr, Option, Schema, String as Str } from "effect"

// Findings Maple pulls from a cloud's own security services, stored per finding at its latest
// version: the AWS connection's `security` module (four services) and the GCP connector's
// Security Command Center. One vocabulary across them.

export const CloudProvider = Schema.Literals(["aws", "gcp"])
export type CloudProvider = typeof CloudProvider.Type

/** An AWS connection or a GCP connector; the row's `provider` says which. */
export const CloudConnectionId = Schema.Union([AwsConnectionId, GcpConnectorId])
export type CloudConnectionId = typeof CloudConnectionId.Type
/** An AWS account, or the GCP project (numeric organization, for org-level findings) a finding is in. */
export const CloudAccountId = Schema.Union([AwsAccountId, GcpProjectId, GcpResourceNumber])
export type CloudAccountId = typeof CloudAccountId.Type
/** An AWS region, or a Security Command Center location (`global` for most findings). */
export const CloudLocation = Schema.Union([AwsRegion, GcpLocation])
export type CloudLocation = typeof CloudLocation.Type

export const AWS_FINDING_SOURCES = ["guardduty", "securityhub", "inspector", "access_analyzer"] as const
export const AwsFindingSource = Schema.Literals(AWS_FINDING_SOURCES)
export type AwsFindingSource = typeof AwsFindingSource.Type

export const GCP_FINDING_SOURCES = ["security_command_center"] as const
export const GcpFindingSource = Schema.Literals(GCP_FINDING_SOURCES)
export type GcpFindingSource = typeof GcpFindingSource.Type

export const CLOUD_FINDING_SOURCES = [...AWS_FINDING_SOURCES, ...GCP_FINDING_SOURCES] as const
export const CloudFindingSource = Schema.Literals(CLOUD_FINDING_SOURCES)
export type CloudFindingSource = typeof CloudFindingSource.Type

export const CLOUD_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const
export const CloudFindingSeverity = Schema.Literals(CLOUD_FINDING_SEVERITIES)
export type CloudFindingSeverity = typeof CloudFindingSeverity.Type

/** What a poller reads per location: a findings service, or (AWS) CloudTrail for the audit log. */
export const CloudSecurityFeed = Schema.Literals([...CLOUD_FINDING_SOURCES, "cloudtrail"])
export type CloudSecurityFeed = typeof CloudSecurityFeed.Type

/** What the AWS poller reads per region. */
export const AwsSecurityFeed = Schema.Literals([...AWS_FINDING_SOURCES, "cloudtrail"])
export type AwsSecurityFeed = typeof AwsSecurityFeed.Type

/** A feed whose last EventBridge event is this recent counts as delivering: the poller slows down for it. */
export const CLOUD_SECURITY_PUSH_ALIVE_MS = 7 * 24 * 60 * 60 * 1000

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
	readonly provider: CloudProvider
	readonly title: string
	/** What it finds, in one line for an empty state. */
	readonly summary: string
	/** Where the customer turns it on. */
	readonly enableUrl: string
}

export const CLOUD_FINDING_SOURCE_SPECS = {
	guardduty: {
		provider: "aws",
		title: "GuardDuty",
		summary: "Threats: compromised credentials, crypto mining, unusual API calls and network traffic.",
		enableUrl: "https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_settingup.html",
	},
	securityhub: {
		provider: "aws",
		title: "Security Hub",
		summary: "Misconfigurations against the AWS Foundational Security Best Practices.",
		enableUrl: "https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-settingup.html",
	},
	inspector: {
		provider: "aws",
		title: "Inspector",
		summary: "Known vulnerabilities in EC2 instances, container images and Lambda functions.",
		enableUrl: "https://docs.aws.amazon.com/inspector/latest/user/getting_started_tutorial.html",
	},
	access_analyzer: {
		provider: "aws",
		title: "IAM Access Analyzer",
		summary: "Resources shared outside the account, and unused roles, keys and permissions.",
		enableUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-getting-started.html",
	},
	security_command_center: {
		provider: "gcp",
		title: "Security Command Center",
		summary: "Threats, misconfigurations and vulnerabilities across the projects in scope.",
		enableUrl: "https://cloud.google.com/security-command-center/docs/activate-scc-overview",
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

/** The provider a source belongs to. */
export const cloudFindingProvider = (source: CloudFindingSource): CloudProvider =>
	CLOUD_FINDING_SOURCE_SPECS[source].provider

/**
 * The finding in its cloud's console: deep links where the console takes one, the findings list
 * otherwise. For Security Command Center `accountId` is the project (or numeric organization) it is in.
 */
export const cloudFindingConsoleUrl = (finding: {
	readonly source: CloudFindingSource
	readonly accountId: string
	readonly region: string
	readonly findingId: string
}): string => {
	const { region, findingId } = finding
	if (finding.source === "security_command_center") {
		const scope = /^[0-9]+$/u.test(finding.accountId) ? "organizationId" : "project"
		return `https://console.cloud.google.com/security/command-center/findings?${scope}=${encodeURIComponent(finding.accountId)}`
	}
	const host = Str.includes("-gov-")(region)
		? `https://console.amazonaws-us-gov.com`
		: Str.startsWith("cn-")(region)
			? `https://console.amazonaws.cn`
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

/** Resource attributes that carry an AWS resource's identity in telemetry. */
export const CLOUD_RESOURCE_ATTRIBUTE_KEYS = [
	"host.id",
	"cloud.resource_id",
	"faas.name",
	"faas.id",
	"aws.ecs.task.arn",
	"aws.ecs.cluster.arn",
	"k8s.cluster.name",
] as const
export type CloudResourceAttributeKey = (typeof CLOUD_RESOURCE_ATTRIBUTE_KEYS)[number]

/**
 * One value telemetry may carry for a resource, on the one attribute that would carry it. A name
 * (`faas.name`, `k8s.cluster.name`) is only unique within an account and region, so it carries the
 * finding's: a span counts for it only when its `cloud.account.id` and `cloud.region` agree or are unset.
 */
export interface CloudResourceCandidate {
	readonly key: CloudResourceAttributeKey
	readonly value: string
	readonly scope: { readonly accountId: string; readonly region: string } | null
}

/** One candidate as the telemetry query names the matches it finds: key, scope and value. */
export const cloudResourceMatchTag = (candidate: CloudResourceCandidate): string =>
	`${candidate.key}\u001f${candidate.scope === null ? "" : `${candidate.scope.accountId}/${candidate.scope.region}`}\u001f${candidate.value}`

/** An ARN is matched whole on the attributes that hold ARNs. */
const ARN_KEYS: ReadonlyArray<CloudResourceAttributeKey> = [
	"cloud.resource_id",
	"faas.id",
	"aws.ecs.task.arn",
	"aws.ecs.cluster.arn",
]

const EC2_INSTANCE_ID = /^i-[0-9a-f]{8,17}$/u

/** The name part of an ARN's resource for the services whose name telemetry carries; undefined otherwise. */
const arnName = (arn: string): Omit<CloudResourceCandidate, "scope"> | undefined => {
	// arn:partition:service:region:account:resource, where resource may itself hold ':' and '/'.
	const parts = Str.split(":")(arn)
	const service = parts[2] ?? ""
	const resource = Arr.join(Arr.drop(parts, 5), ":")
	const after = (prefix: string) =>
		Str.startsWith(prefix)(resource) ? Str.slice(prefix.length)(resource) : undefined
	if (service === "ec2") {
		const instance = after("instance/")
		return instance !== undefined && EC2_INSTANCE_ID.test(instance)
			? { key: "host.id", value: instance }
			: undefined
	}
	if (service === "lambda") {
		// `function:name` or `function:name:qualifier`: the qualifier is a version or alias, not a name.
		const name = Arr.head(Str.split(":")(after("function:") ?? "")).pipe(Option.getOrElse(() => ""))
		return name === "" ? undefined : { key: "faas.name", value: name }
	}
	if (service === "eks") {
		const name = Arr.head(Str.split("/")(after("cluster/") ?? "")).pipe(Option.getOrElse(() => ""))
		return name === "" ? undefined : { key: "k8s.cluster.name", value: name }
	}
	return undefined
}

/**
 * The values telemetry may carry for a finding's resource, each on the attribute that would carry
 * it: an ARN whole, plus its name for EC2 instances, Lambda functions and EKS clusters; a bare id
 * only where its type says what it is. A short tail is never matched loosely, so `function:x:prod`
 * cannot match a `prod` cluster.
 */
export const cloudResourceCandidates = (resource: {
	readonly resourceId: string
	readonly resourceType: string
	readonly accountId: string
	readonly region: string
}): ReadonlyArray<CloudResourceCandidate> => {
	const id = Str.trim(resource.resourceId)
	if (id === "") return []
	const scope = { accountId: resource.accountId, region: resource.region }
	// Names are scoped to the finding's account and region; ids and ARNs are unique on their own.
	const scoped = (candidate: Omit<CloudResourceCandidate, "scope">): CloudResourceCandidate => ({
		...candidate,
		scope: candidate.key === "faas.name" || candidate.key === "k8s.cluster.name" ? scope : null,
	})
	if (Str.startsWith("arn:")(id)) {
		const name = arnName(id)
		const whole = Arr.map(ARN_KEYS, (key): CloudResourceCandidate => ({ key, value: id, scope: null }))
		return name === undefined ? whole : Arr.append(whole, scoped(name))
	}
	const type = Str.toLowerCase(resource.resourceType)
	// The type first: `i-0123456789abcdef0` is a valid Lambda function name too.
	if (Str.includes("lambda")(type)) return [scoped({ key: "faas.name", value: id })]
	if (Str.includes("eks")(type)) return [scoped({ key: "k8s.cluster.name", value: id })]
	if (EC2_INSTANCE_ID.test(id)) return [scoped({ key: "host.id", value: id })]
	return []
}
