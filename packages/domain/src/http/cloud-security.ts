import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { AwsAccountId, AwsConnectionId, AwsRegion } from "@maple/primitives"
import {
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
	CloudServiceState,
} from "../cloud-security"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { EndpointAccess } from "./endpoint-access"

// The Security hub's Cloud tab: findings the AWS connection's `security` module pulls from
// GuardDuty, Security Hub, Inspector and Access Analyzer, matched to the services they affect.

export const CLOUD_FINDINGS_PAGE_MAX = 100

/** A service whose spans carried the finding's resource id in the last day. */
export const CloudFindingAffectedService = Schema.Struct({
	service: Schema.String,
	/** Sample-weighted requests it served from the resource over the window. */
	requests: Schema.Finite,
})
export type CloudFindingAffectedService = typeof CloudFindingAffectedService.Type

const findingFields = {
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	region: AwsRegion,
	source: CloudFindingSource,
	findingId: Schema.String,
	type: Schema.String,
	title: Schema.String,
	description: Schema.NullOr(Schema.String),
	severity: CloudFindingSeverity,
	status: CloudFindingStatus,
	resourceType: Schema.String,
	resourceId: Schema.String,
	resourceName: Schema.NullOr(Schema.String),
	occurrences: Schema.Finite,
	/** Epoch ms. */
	firstSeenAt: Schema.Finite,
	lastSeenAt: Schema.Finite,
	syncedAt: Schema.Finite,
	/** The finding in the AWS console. */
	consoleUrl: Schema.String,
	/** Busiest first; empty when no telemetry carried the resource, or it could not be read. */
	affectedServices: Schema.Array(CloudFindingAffectedService),
}

export const CloudFinding = Schema.Struct(findingFields)
export type CloudFinding = typeof CloudFinding.Type

export const CloudFindingDetail = Schema.Struct({
	...findingFields,
	/** The service's finding, trimmed; null when it was too large to keep. */
	detail: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
})
export type CloudFindingDetail = typeof CloudFindingDetail.Type

const SearchText = Schema.Trim.check(Schema.isMaxLength(200))

export const CloudFindingsListRequest = Schema.Struct({
	/** Absent: active. */
	status: Schema.optionalKey(CloudFindingStatus),
	severities: Schema.optionalKey(Schema.Array(CloudFindingSeverity).check(Schema.isMaxLength(5))),
	sources: Schema.optionalKey(Schema.Array(CloudFindingSource).check(Schema.isMaxLength(4))),
	accountId: Schema.optionalKey(AwsAccountId),
	region: Schema.optionalKey(AwsRegion),
	/** Matched against the title, type and resource id. */
	search: Schema.optionalKey(SearchText),
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: CLOUD_FINDINGS_PAGE_MAX }),
		),
	),
	offset: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100_000 })),
	),
})
export type CloudFindingsListRequest = typeof CloudFindingsListRequest.Type

/** Severity first, then the newest sighting. `nextOffset` is null on the last page. */
export const CloudFindingsListResponse = Schema.Struct({
	findings: Schema.Array(CloudFinding),
	nextOffset: Schema.NullOr(Schema.Finite),
	/** False when the telemetry match could not be read: `affectedServices` are all empty then. */
	telemetryMatched: Schema.Boolean,
})
export type CloudFindingsListResponse = typeof CloudFindingsListResponse.Type

export const CloudFindingDetailQuery = Schema.Struct({
	connectionId: AwsConnectionId,
	region: AwsRegion,
	source: CloudFindingSource,
	findingId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
})
export type CloudFindingDetailQuery = typeof CloudFindingDetailQuery.Type

export const CloudFindingDetailResponse = Schema.Struct({
	finding: CloudFindingDetail,
	telemetryMatched: Schema.Boolean,
})
export type CloudFindingDetailResponse = typeof CloudFindingDetailResponse.Type

/** One service in one region of one connection, as the last poll found it. */
export const CloudSecurityServiceStatus = Schema.Struct({
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	region: AwsRegion,
	source: CloudFindingSource,
	state: CloudServiceState,
	lastError: Schema.NullOr(Schema.String),
	checkedAt: Schema.Finite,
	/** The last finding event EventBridge delivered; null while the feed is only polled. */
	pushedAt: Schema.NullOr(Schema.Finite),
})
export type CloudSecurityServiceStatus = typeof CloudSecurityServiceStatus.Type

/**
 * Where the org's AWS security module stands. `requested`: the connection asks for it but the
 * deployed stack does not grant it yet. `granted`: the role carries it.
 */
export const CloudSecurityConnectionModule = Schema.Literals(["not_requested", "requested", "granted"])
export type CloudSecurityConnectionModule = typeof CloudSecurityConnectionModule.Type

export const CloudSecurityConnection = Schema.Struct({
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	module: CloudSecurityConnectionModule,
})
export type CloudSecurityConnection = typeof CloudSecurityConnection.Type

const countsBySeverity = Schema.Struct({
	critical: Schema.Finite,
	high: Schema.Finite,
	medium: Schema.Finite,
	low: Schema.Finite,
	info: Schema.Finite,
})

const countsBySource = Schema.Struct({
	guardduty: Schema.Finite,
	securityhub: Schema.Finite,
	inspector: Schema.Finite,
	access_analyzer: Schema.Finite,
})

export const CloudSecurityOverviewResponse = Schema.Struct({
	/** Every AWS connection of the org; empty when AWS is not connected. */
	connections: Schema.Array(CloudSecurityConnection),
	/** Active findings. */
	summary: Schema.Struct({
		total: Schema.Finite,
		bySeverity: countsBySeverity,
		bySource: countsBySource,
	}),
	services: Schema.Array(CloudSecurityServiceStatus),
})
export type CloudSecurityOverviewResponse = typeof CloudSecurityOverviewResponse.Type

/** The org is not in the `cloudSecurity` rollout. */
export class CloudSecurityDisabledError extends HttpTaggedError<CloudSecurityDisabledError>()(
	"@maple/http/errors/CloudSecurityDisabledError",
	{ message: Schema.String },
	{
		status: 403,
		code: "cloud_security_disabled",
		title: "Cloud security is not enabled",
		retry: "never",
		recovery: "contact_support",
		exposure: "public_message",
	},
) {}

/** The caller lacks `security:manage`: findings and their raw records are for engineers and admins. */
export class CloudSecurityForbiddenError extends HttpTaggedError<CloudSecurityForbiddenError>()(
	"@maple/http/errors/CloudSecurityForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "cloud_security_forbidden",
		title: "Not allowed to read cloud findings",
		retry: "never",
		recovery: "contact_support",
		exposure: "public_message",
	},
) {}

export class CloudSecurityPersistenceError extends HttpTaggedError<CloudSecurityPersistenceError>()(
	"@maple/http/errors/CloudSecurityPersistenceError",
	/** `cause` names the failure behind it (its tag), never its details. */
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "cloud_security_unavailable",
		title: "Cloud findings are temporarily unavailable",
		message: "Cloud findings are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class CloudFindingNotFoundError extends HttpTaggedError<CloudFindingNotFoundError>()(
	"@maple/http/errors/CloudFindingNotFoundError",
	{ message: Schema.String },
	{
		status: 404,
		code: "cloud_finding_not_found",
		title: "Finding not found",
		message: "No such finding.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class CloudSecurityApiGroup extends HttpApiGroup.make("cloudSecurity")
	.add(
		HttpApiEndpoint.get("overview", "/overview", {
			success: CloudSecurityOverviewResponse,
			error: [CloudSecurityDisabledError, CloudSecurityForbiddenError, CloudSecurityPersistenceError],
		}),
	)
	.add(
		// A POST for the list filters; it only reads. Not for analysts: the Security Center is engineers' and admins'.
		HttpApiEndpoint.post("listFindings", "/findings", {
			payload: CloudFindingsListRequest,
			success: CloudFindingsListResponse,
			error: [CloudSecurityDisabledError, CloudSecurityForbiddenError, CloudSecurityPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("finding", "/finding", {
			query: CloudFindingDetailQuery,
			success: CloudFindingDetailResponse,
			error: [
				CloudSecurityDisabledError,
				CloudSecurityForbiddenError,
				CloudSecurityPersistenceError,
				CloudFindingNotFoundError,
			],
		}),
	)
	.prefix("/internal/cloud-security")
	.middleware(SessionAuthorization)
	// Findings carry principals, addresses and exposed resources, and the list reads telemetry.
	.annotate(AuditedRead, "telemetry.read")
	.annotate(EndpointAccess, "handler") {}
