import {
	type CloudFindingDetailResponse,
	CloudFindingDetailResponse as DetailSchema,
	type CloudFindingsListResponse,
	type CloudSecurityOverviewResponse,
	CloudSecurityOverviewResponse as OverviewSchema,
	CloudFindingsListResponse as ListSchema,
} from "@maple/domain/http"
import { cloudFindingConsoleUrl } from "@maple/domain/cloud-security"
import { Array as Arr, Order, Schema } from "effect"

// Cloud security findings for `/lab/security?state=cloud*` and the Cloud tab's scene tests: one
// production AWS account in two regions, with a GuardDuty threat on a host that serves checkout,
// and a Google Cloud connector on the `acme-prod` project read through Security Command Center.

const CONNECTION_ID = "8a3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80"
const ACCOUNT_ID = "123456789012"
const GCP_CONNECTOR_ID = "4f2d8a91-3c7b-4e15-8f6a-9b0c1d2e3f40"
const GCP_PROJECT = "acme-prod"
const GCP_ORG = "482910375516"
const MINUTE = 60_000

const decodeOverview = Schema.decodeUnknownSync(OverviewSchema)
const decodeList = Schema.decodeUnknownSync(ListSchema)

type Module = "not_requested" | "requested" | "granted"

const connections = (module: Module) => [
	{ provider: "aws", connectionId: CONNECTION_ID, accountId: ACCOUNT_ID, module },
]

const gcpConnection = (module: Module) => ({
	provider: "gcp",
	connectionId: GCP_CONNECTOR_ID,
	accountId: GCP_PROJECT,
	module,
})

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

/** Security Command Center for the connector's project, at `global` as SCC answers. */
const sccService = (
	nowMs: number,
	state: string,
	options: Readonly<{ lastError?: string; pushedAt?: number }> = {},
) => ({
	provider: "gcp",
	connectionId: GCP_CONNECTOR_ID,
	accountId: GCP_PROJECT,
	region: "global",
	source: "security_command_center",
	state,
	lastError: options.lastError ?? null,
	checkedAt: nowMs - 3 * MINUTE,
	pushedAt: options.pushedAt ?? null,
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
	source: "guardduty" | "securityhub" | "inspector" | "access_analyzer" | "security_command_center"
	region?: string
	/** Google Cloud only: the project (or numeric organization) the finding is in. */
	account?: string
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
	const isGcp = wire.source === "security_command_center"
	const region = wire.region ?? (isGcp ? "global" : "us-east-1")
	const accountId = wire.account ?? (isGcp ? GCP_PROJECT : ACCOUNT_ID)
	const lastSeenAt = nowMs - wire.minutesAgo * MINUTE
	return {
		provider: isGcp ? "gcp" : "aws",
		connectionId: isGcp ? GCP_CONNECTOR_ID : CONNECTION_ID,
		accountId,
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
			accountId,
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

// Google Cloud: Security Command Center findings as the backend stores them. The id is SCC's
// finding name, the type `<findingClass>/<category>`, the title the category in words.

const sccName = (source: string, id: string, location = "global") =>
	`organizations/${GCP_ORG}/sources/${source}/locations/${location}/findings/${id}`

const GCP_WIRES: ReadonlyArray<Wire> = [
	{
		id: sccName("1180724655371226513", "b7e0c4a2f1d94e3a8c5b6d7e8f901234"),
		source: "security_command_center",
		severity: "critical",
		type: "THREAT/Persistence: IAM Anomalous Grant",
		title: "Persistence: IAM Anomalous Grant",
		description:
			"Event Threat Detection saw a principal outside the organization granted roles/owner on the project.",
		resourceType: "google.cloud.resourcemanager.Project",
		resourceId: "//cloudresourcemanager.googleapis.com/projects/482910375599",
		resourceName: GCP_PROJECT,
		minutesAgo: 12,
	},
	{
		id: sccName("9342871650412387761", "0c9f8e7d6c5b4a39281706f5e4d3c2b1"),
		source: "security_command_center",
		severity: "high",
		type: "MISCONFIGURATION/PUBLIC_BUCKET_ACL",
		title: "Public bucket ACL",
		description: "The bucket's ACL grants read access to allUsers.",
		resourceType: "google.cloud.storage.Bucket",
		resourceId: "//storage.googleapis.com/acme-prod-exports",
		resourceName: "acme-prod-exports",
		minutesAgo: 140,
	},
	{
		id: sccName("9342871650412387761", "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d"),
		source: "security_command_center",
		severity: "high",
		type: "MISCONFIGURATION/OPEN_FIREWALL",
		title: "Open firewall",
		description: "Firewall rule allow-ssh-all accepts TCP 22 from 0.0.0.0/0.",
		resourceType: "google.compute.Firewall",
		resourceId: "//compute.googleapis.com/projects/acme-prod/global/firewalls/allow-ssh-all",
		resourceName: "allow-ssh-all",
		minutesAgo: 380,
	},
	{
		id: sccName("9342871650412387761", "e1d2c3b4a5968778695a4b3c2d1e0f9a"),
		source: "security_command_center",
		account: GCP_ORG,
		severity: "medium",
		type: "MISCONFIGURATION/MFA_NOT_ENFORCED",
		title: "MFA not enforced",
		description: "2-step verification is not enforced for users in the organization.",
		resourceType: "google.cloud.resourcemanager.Organization",
		resourceId: `//cloudresourcemanager.googleapis.com/organizations/${GCP_ORG}`,
		resourceName: "acme.dev",
		minutesAgo: 2_880,
	},
	{
		id: sccName("9342871650412387761", "77f6e5d4c3b2a1908f7e6d5c4b3a2918"),
		source: "security_command_center",
		severity: "low",
		type: "MISCONFIGURATION/OS_LOGIN_DISABLED",
		title: "OS login disabled",
		description: "OS Login is disabled on the instance, so SSH keys in metadata grant access.",
		resourceType: "google.compute.Instance",
		resourceId:
			"//compute.googleapis.com/projects/acme-prod/zones/us-central1-a/instances/checkout-api-1",
		resourceName: "checkout-api-1",
		minutesAgo: 4_320,
		services: [["checkout-api", 860]],
	},
]

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const

/** Severity first, then the newest sighting: the list's own order. */
const ordered = (wires: ReadonlyArray<Wire>) =>
	Arr.sort(
		wires,
		Order.combine(
			Order.mapInput(Order.Number, (wire: Wire) => SEVERITY_RANK[wire.severity]),
			Order.mapInput(Order.Number, (wire: Wire) => wire.minutesAgo),
		),
	)

const servicesWithGcp = (nowMs: number) => [
	...Arr.map(enabledEverywhere(nowMs), (row) =>
		row.source === "guardduty" || row.source === "securityhub"
			? { ...row, pushedAt: nowMs - 2 * MINUTE }
			: row,
	),
	sccService(nowMs, "enabled", { pushedAt: nowMs - 6 * MINUTE }),
]

/** AWS and Google Cloud both connected and granted. */
export const mixedOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: [...connections("granted"), gcpConnection("granted")],
		summary: {
			total: 10,
			bySeverity: { critical: 2, high: 4, medium: 2, low: 2, info: 0 },
			bySource: {
				...ZERO_SOURCE,
				guardduty: 2,
				securityhub: 2,
				inspector: 1,
				security_command_center: 5,
			},
		},
		services: servicesWithGcp(nowMs),
	})

export const mixedFindingsOf = (nowMs: number): CloudFindingsListResponse =>
	decodeList({
		findings: Arr.map(ordered([...WIRES, ...GCP_WIRES]), (wire) => findingOf(nowMs, wire)),
		nextOffset: null,
		telemetryMatched: true,
	})

/** Only Google Cloud connected, and granted. */
export const gcpOnlyOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: [gcpConnection("granted")],
		summary: {
			total: 5,
			bySeverity: { critical: 1, high: 2, medium: 1, low: 1, info: 0 },
			bySource: { ...ZERO_SOURCE, security_command_center: 5 },
		},
		services: [sccService(nowMs, "enabled", { pushedAt: nowMs - 6 * MINUTE })],
	})

export const gcpFindingsOf = (nowMs: number): CloudFindingsListResponse =>
	decodeList({
		findings: Arr.map(GCP_WIRES, (wire) => findingOf(nowMs, wire)),
		nextOffset: null,
		telemetryMatched: true,
	})

/** Only Google Cloud connected, its connector not asking for findings or not set up for them yet. */
export const gcpModuleOverview = (module: "not_requested" | "requested"): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: [gcpConnection(module)],
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: [],
	})

/** AWS findings listing while the Google Cloud connector waits for its setup to be run again. */
export const awsWithGcpRequestedOverview = (nowMs: number): CloudSecurityOverviewResponse => {
	const aws = populatedOverview(nowMs)
	return decodeOverview({ ...aws, connections: [...aws.connections, gcpConnection("requested")] })
}

/** Google Cloud granted, but Security Command Center is not activated for the project. */
export const gcpNotActivatedOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: [gcpConnection("granted")],
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: [sccService(nowMs, "not_enabled")],
	})

/** Google Cloud granted, and the reader may not list findings (the role was removed). */
export const gcpDeniedOverview = (nowMs: number): CloudSecurityOverviewResponse =>
	decodeOverview({
		connections: [gcpConnection("granted")],
		summary: { total: 0, bySeverity: ZERO_SEVERITY, bySource: ZERO_SOURCE },
		services: [
			sccService(nowMs, "denied", {
				lastError: "PERMISSION_DENIED: Permission 'securitycenter.findings.list' denied on resource.",
			}),
		],
	})

/** The Event Threat Detection grant on the project, with SCC's own finding trimmed. */
export const gcpFindingDetailOf = (nowMs: number): CloudFindingDetailResponse => {
	const wire = GCP_WIRES[0]
	const finding = wire === undefined ? undefined : findingOf(nowMs, wire)
	return decodeDetail({
		telemetryMatched: true,
		finding: {
			...finding,
			detail: {
				finding: {
					name: finding?.findingId,
					category: "Persistence: IAM Anomalous Grant",
					findingClass: "THREAT",
					severity: "CRITICAL",
					state: "ACTIVE",
					resourceName: finding?.resourceId,
				},
				resource: { type: finding?.resourceType, displayName: GCP_PROJECT },
			},
		},
	})
}

/** The detail URL's search for the first Google Cloud fixture finding. */
export const GCP_DETAIL_SEARCH = {
	connection: GCP_CONNECTOR_ID,
	region: "global",
	source: "security_command_center",
	id: GCP_WIRES[0]?.id ?? "",
}
