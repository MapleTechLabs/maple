import {
	type CloudFindingDetailResponse,
	CloudFindingDetailResponse as DetailSchema,
	type CloudFindingsListResponse,
	type CloudSecurityOverviewResponse,
	CloudSecurityOverviewResponse as OverviewSchema,
	CloudFindingsListResponse as ListSchema,
} from "@maple/domain/http"
import { cloudFindingConsoleUrl } from "@maple/domain/cloud-security"
import { Array as Arr, Schema } from "effect"

// AWS security findings for `/lab/security?state=cloud*` and the Cloud tab's scene tests: one
// production account in two regions, with a GuardDuty threat on a host that serves checkout.

const CONNECTION_ID = "8a3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80"
const ACCOUNT_ID = "123456789012"
const MINUTE = 60_000

const decodeOverview = Schema.decodeUnknownSync(OverviewSchema)
const decodeList = Schema.decodeUnknownSync(ListSchema)

const connections = (module: "not_requested" | "requested" | "granted") => [
	{ provider: "aws", connectionId: CONNECTION_ID, accountId: ACCOUNT_ID, module },
]

const ZERO_SEVERITY = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
const ZERO_SOURCE = {
	guardduty: 0,
	securityhub: 0,
	inspector: 0,
	access_analyzer: 0,
	security_command_center: 0,
}

const service = (
	nowMs: number,
	source: string,
	region: string,
	state: string,
	lastError: string | null = null,
) => ({
	provider: "aws",
	connectionId: CONNECTION_ID,
	accountId: ACCOUNT_ID,
	region,
	source,
	state,
	lastError,
	checkedAt: nowMs - 4 * MINUTE,
	pushedAt: null,
})

const enabledEverywhere = (nowMs: number) =>
	Arr.flatMap(["us-east-1", "eu-west-1"], (region) =>
		Arr.map(["guardduty", "securityhub", "inspector", "access_analyzer"], (source) =>
			service(nowMs, source, region, "enabled"),
		),
	)

export const noConnectionOverview: CloudSecurityOverviewResponse = decodeOverview({
	connections: [],
	summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
	services: [],
})

export const moduleOverview = (module: "not_requested" | "requested"): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: connections(module),
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: [],
	})

export const populatedOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: connections("granted"),
		summary: {
			total: 5,
			bySeverity: { critical: 1, high: 2, medium: 1, low: 1, info: 0 },
			bySource: { ...ZERO_SOURCE, guardduty: 2, securityhub: 2, inspector: 1 },
		},
		services: [
			// GuardDuty and Security Hub deliver events; the others are only polled.
			...Arr.map(
				Arr.filter(
					enabledEverywhere(nowMs),
					(row) => !(row.source === "inspector" && row.region === "eu-west-1"),
				),
				(row) =>
					row.source === "guardduty" || row.source === "securityhub"
						? { ...row, pushedAt: nowMs - 2 * MINUTE }
						: row,
			),
			service(nowMs, "inspector", "eu-west-1", "not_enabled"),
		],
	})

export const allClearOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: connections("granted"),
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: enabledEverywhere(nowMs),
	})

/** Granted, and no service read yet. */
export const firstReadPendingOverview: CloudSecurityOverviewResponse = decodeOverview({
	connections: connections("granted"),
	summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
	services: [],
})

export const failingOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: connections("granted"),
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: [
			...Arr.filter(
				enabledEverywhere(nowMs),
				(row) => row.source === "guardduty" || row.source === "inspector",
			),
			service(nowMs, "securityhub", "us-east-1", "failing", "ThrottlingException: Rate exceeded"),
			service(nowMs, "securityhub", "eu-west-1", "failing", "ThrottlingException: Rate exceeded"),
			service(
				nowMs,
				"access_analyzer",
				"us-east-1",
				"denied",
				"AccessDeniedException: not authorized to perform access-analyzer:ListFindingsV2",
			),
		],
	})

type Wire = Readonly<{
	id: string
	source: "guardduty" | "securityhub" | "inspector" | "access_analyzer"
	region?: string
	severity: "critical" | "high" | "medium" | "low" | "info"
	type: string
	title: string
	description: string
	resourceType: string
	resourceId: string
	resourceName?: string
	minutesAgo: number
	occurrences?: number
	services?: ReadonlyArray<readonly [string, number]>
}>

const WIRES: ReadonlyArray<Wire> = [
	{
		id: "6ec6f1e2b3a44d6c8f0a1b2c3d4e5f60",
		source: "guardduty",
		severity: "critical",
		type: "CryptoCurrency:EC2/BitcoinTool.B!DNS",
		title: "EC2 instance i-0c3f9a2b1d4e5f678 is querying a domain name associated with Bitcoin activity",
		description:
			"The instance is querying a domain that is associated with cryptocurrency mining. This instance may be compromised.",
		resourceType: "Instance",
		resourceId: "i-0c3f9a2b1d4e5f678",
		resourceName: "checkout-api-prod-2",
		minutesAgo: 7,
		occurrences: 42,
		services: [
			["checkout-api", 1240],
			["cart", 88],
		],
	},
	{
		id: "arn:aws:securityhub:us-east-1:123456789012:subscription/aws-foundational-security-best-practices/v/1.0.0/S3.8/finding/1f2e3d4c",
		source: "securityhub",
		severity: "high",
		type: "S3.8",
		title: "S3 general purpose buckets should block public access",
		description:
			"This control checks whether an S3 bucket has bucket-level Block Public Access settings.",
		resourceType: "AwsS3Bucket",
		resourceId: "arn:aws:s3:::acme-static-assets",
		minutesAgo: 95,
	},
	{
		id: "arn:aws:inspector2:us-east-1:123456789012:finding/0a1b2c3d4e5f",
		source: "inspector",
		severity: "high",
		type: "PACKAGE_VULNERABILITY",
		title: "CVE-2024-45337 - golang.org/x/crypto",
		description:
			"Applications using ServerConfig.PublicKeyCallback may be susceptible to an authorization bypass.",
		resourceType: "AWS_LAMBDA_FUNCTION",
		resourceId: "arn:aws:lambda:us-east-1:123456789012:function:payments-webhook",
		resourceName: "payments-webhook",
		minutesAgo: 240,
		services: [["payments-webhook", 312]],
	},
	{
		id: "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e",
		source: "guardduty",
		region: "eu-west-1",
		severity: "medium",
		type: "Recon:EC2/PortProbeUnprotectedPort",
		title: "Unprotected port on EC2 instance i-0e1d2c3b4a5968778 is being probed",
		description: "Port 22 is being probed by a known scanner.",
		resourceType: "Instance",
		resourceId: "i-0e1d2c3b4a5968778",
		minutesAgo: 600,
		occurrences: 310,
	},
	{
		id: "arn:aws:securityhub:eu-west-1:123456789012:subscription/aws-foundational-security-best-practices/v/1.0.0/IAM.6/finding/7a8b9c",
		source: "securityhub",
		region: "eu-west-1",
		severity: "low",
		type: "IAM.6",
		title: "Hardware MFA should be enabled for the root user",
		description: "This control checks whether the root user signs in with hardware MFA.",
		resourceType: "AwsAccount",
		resourceId: "AWS::::Account:123456789012",
		minutesAgo: 1_440,
	},
]

const findingOf = (nowMs: number, wire: Wire) => {
	const region = wire.region ?? "us-east-1"
	const lastSeenAt = nowMs - wire.minutesAgo * MINUTE
	return {
		provider: "aws",
		connectionId: CONNECTION_ID,
		accountId: ACCOUNT_ID,
		region,
		source: wire.source,
		findingId: wire.id,
		type: wire.type,
		title: wire.title,
		description: wire.description,
		severity: wire.severity,
		status: "active",
		resourceType: wire.resourceType,
		resourceId: wire.resourceId,
		resourceName: wire.resourceName ?? null,
		occurrences: wire.occurrences ?? 1,
		firstSeenAt: lastSeenAt - 3 * 24 * 60 * MINUTE,
		lastSeenAt,
		syncedAt: nowMs - 4 * MINUTE,
		consoleUrl: cloudFindingConsoleUrl({
			source: wire.source,
			accountId: ACCOUNT_ID,
			region,
			findingId: wire.id,
		}),
		affectedServices: Arr.map(wire.services ?? [], ([name, requests]) => ({ service: name, requests })),
	}
}

export const cloudFindingsOf = (nowMs: number): CloudFindingsListResponse =>
	decodeList({
		findings: Arr.map(WIRES, (wire) => findingOf(nowMs, wire)),
		nextOffset: null,
		telemetryMatched: true,
	})

export const noCloudFindings: CloudFindingsListResponse = {
	findings: [],
	nextOffset: null,
	telemetryMatched: true,
}

const decodeDetail = Schema.decodeUnknownSync(DetailSchema)

/** The GuardDuty threat on the checkout host, with the service's own finding trimmed. */
export const cloudFindingDetailOf = (nowMs: number): CloudFindingDetailResponse => {
	const finding = Arr.map(Arr.take(WIRES, 1), (wire) => findingOf(nowMs, wire))[0]
	return decodeDetail({
		telemetryMatched: true,
		finding: {
			...finding,
			detail: {
				Type: finding?.type,
				Severity: 8.9,
				Service: {
					Count: 42,
					Action: { ActionType: "DNS_REQUEST", DnsRequestAction: { Domain: "pool.minexmr.com" } },
				},
				Resource: { InstanceDetails: { InstanceId: finding?.resourceId, InstanceType: "m6i.large" } },
			},
		},
	})
}

/** The detail URL's search for the first fixture finding. */
export const CLOUD_DETAIL_SEARCH = {
	connection: CONNECTION_ID,
	region: "us-east-1",
	source: "guardduty",
	id: WIRES[0]?.id ?? "",
}
