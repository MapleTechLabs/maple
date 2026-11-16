/**
 * Reads one AWS security service in one region with an assumed-role session. Each reader answers
 * with the service's state there, the findings changed since the cursor, and the next cursor. Owns
 * the SDK imports, so `AwsSecurityFindingsService` loads it with the first poll.
 */
import * as AccessAnalyzer from "@distilled.cloud/aws/accessanalyzer"
import * as Account from "@distilled.cloud/aws/account"
import * as Category from "@distilled.cloud/aws/Category"
import * as CloudTrail from "@distilled.cloud/aws/cloudtrail"
import * as Credentials from "@distilled.cloud/aws/Credentials"
import { UnknownAwsError } from "@distilled.cloud/aws/Errors"
import * as GuardDuty from "@distilled.cloud/aws/guardduty"
import * as Inspector from "@distilled.cloud/aws/inspector2"
import * as Retry from "@distilled.cloud/aws/Retry"
import * as SecurityHub from "@distilled.cloud/aws/securityhub"
import {
	type CloudFindingSeverity,
	type CloudFindingSource,
	type CloudFindingStatus,
	type CloudServiceState,
	cloudFindingSeverityOfLabel,
	cloudFindingSeverityOfScore,
} from "@maple/domain/cloud-security"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import { AwsRegion } from "@maple/primitives"
import {
	Array as Arr,
	DateTime,
	Duration,
	Effect,
	Number as Num,
	Option,
	Schema,
	String as Str,
} from "effect"
import { HttpClient } from "effect/http"
import type { AwsRoleSession } from "../integrations/aws/api"
import { cloudTrailAuditEvent } from "./cloudtrail-events"

const REQUEST_TIMEOUT = Duration.seconds(20)
const RETRY: Retry.Options = {
	while: Category.isTransientError,
	backoff: { baseMs: 500, factor: 2, capMs: 2000, maxRetries: 2, jitterMs: 50 },
}
/** Pages one service reads in one region per poll; a poll past it resumes from the cursor next time. */
export const MAX_PAGES = 20
/** A finding's service record above this many bytes keeps only its columns. */
const DETAIL_LIMIT_BYTES = 16 * 1024

const DENIED_CODES = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation"])
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const isRegion = Schema.is(AwsRegion)

/** A read that stopped: `denied` is the role, anything else is AWS. */
export class AwsSecurityReadError extends Schema.TaggedError<AwsSecurityReadError>()(
	"@maple/backend/cloud-security/AwsSecurityReadError",
	{
		message: Schema.String,
		kind: Schema.Literals(["denied", "not_enabled", "failing"]),
	},
) {}

/** A finding as a reader saw it, before the poller stamps the connection's columns. */
export interface FindingRead {
	readonly findingId: string
	readonly type: string
	readonly title: string
	readonly description: string | null
	readonly severity: CloudFindingSeverity
	readonly status: CloudFindingStatus
	readonly resourceType: string
	readonly resourceId: string
	readonly resourceName: string | null
	readonly occurrences: number
	readonly firstSeenAt: number
	readonly lastSeenAt: number
	readonly providerUpdatedAt: number
	readonly detail: Record<string, unknown> | null
}

export interface RegionRead {
	readonly state: CloudServiceState
	readonly findings: ReadonlyArray<FindingRead>
	/** The cursor to store; null keeps the stored one. */
	readonly cursorAt: number | null
	/** Why the read stopped short, or why the service is not readable. */
	readonly lastError: string | null
}

export interface ReadTarget {
	readonly httpClient: HttpClient.HttpClient
	readonly session: AwsRoleSession
	readonly accountId: string
	readonly region: AwsRegion
	/** The stored cursor: the newest service update time already read. Null on the first poll. */
	readonly cursorAt: number | null
}

const codeOf = (error: { readonly _tag: string }) =>
	error instanceof UnknownAwsError ? (error.code ?? error._tag) : error._tag

const messageOf = (what: string, error: { readonly _tag: string }) => {
	const detail =
		"message" in error && typeof error.message === "string" ? Str.slice(0, 200)(error.message) : ""
	return `${what}: ${detail === "" ? codeOf(error) : detail}`
}

/** One SDK call as the session, with a bounded retry and timeout, failing as a read error. */
const callAs =
	(target: ReadTarget) =>
	<A, E extends { readonly _tag: string }>(
		what: string,
		effect: Effect.Effect<A, E, Credentials.Credentials | HttpClient.HttpClient>,
		notEnabledCodes: ReadonlySet<string> = new Set(),
	) =>
		Effect.gen(function* () {
			// A policy the caller installed wins, so a test runs without the backoff sleeps.
			const installed = yield* Effect.serviceOption(Retry.Retry)
			const retry = Option.getOrElse(installed, () => RETRY)
			return yield* effect.pipe(
				Effect.provideService(Retry.Retry, retry),
				Effect.provideService(Credentials.Credentials, target.session.credentials),
				Effect.provideService(HttpClient.HttpClient, target.httpClient),
				Effect.mapError((error) => {
					const code = codeOf(error)
					const kind = DENIED_CODES.has(code)
						? "denied"
						: notEnabledCodes.has(code)
							? "not_enabled"
							: "failing"
					return new AwsSecurityReadError({ message: messageOf(what, error), kind })
				}),
				Effect.timeoutOrElse({
					duration: REQUEST_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new AwsSecurityReadError({
								message: `${what}: AWS did not answer in time`,
								kind: "failing",
							}),
						),
				}),
				Effect.withSpan(`AwsSecurity.${what}`, {
					kind: "client",
					attributes: { "maple.aws.region": target.region },
				}),
			)
		})

/** Pages of a listing until it ends or `MAX_PAGES`; `complete` says which. */
const pagesOf = <A>(
	page: (
		token: string | undefined,
	) => Effect.Effect<
		{ readonly items: ReadonlyArray<A>; readonly next: string | undefined },
		AwsSecurityReadError
	>,
): Effect.Effect<{ readonly items: ReadonlyArray<A>; readonly complete: boolean }, AwsSecurityReadError> => {
	const go = (
		token: string | undefined,
		seen: ReadonlyArray<A>,
		count: number,
	): Effect.Effect<
		{ readonly items: ReadonlyArray<A>; readonly complete: boolean },
		AwsSecurityReadError
	> =>
		Effect.flatMap(page(token), ({ items, next }) => {
			const all = Arr.appendAll(seen, items)
			if (next === undefined || next === "") return Effect.succeed({ items: all, complete: true })
			return count >= MAX_PAGES
				? Effect.succeed({ items: all, complete: false })
				: go(next, all, count + 1)
		})
	return go(undefined, [], 1)
}

const msOf = (value: string | Date | undefined): number | undefined =>
	value === undefined
		? undefined
		: Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.toEpochMillis))

/** The service's record, unless it is too large to keep. */
const detailOf = (detail: Record<string, unknown>): Record<string, unknown> | null =>
	new TextEncoder().encode(encodeJson(detail)).length > DETAIL_LIMIT_BYTES ? null : detail

const newestOf = (findings: ReadonlyArray<FindingRead>): number | undefined =>
	Arr.match(findings, {
		onEmpty: () => undefined,
		onNonEmpty: (all) => Arr.reduce(all, 0, (max, finding) => Num.max(max, finding.providerUpdatedAt)),
	})

/**
 * Where a sorted read leaves the cursor: at the newest update read, never behind the stored one.
 * Reads overlap on that instant, which the upsert absorbs.
 */
const sortedCursor = (target: ReadTarget, findings: ReadonlyArray<FindingRead>): number | null => {
	const newest = newestOf(findings)
	return newest === undefined ? null : Num.max(newest, target.cursorAt ?? 0)
}

const readFinding = (finding: {
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
}): FindingRead => {
	const updatedAt = finding.updatedAt ?? finding.lastSeenAt ?? finding.firstSeenAt ?? 0
	return {
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
	}
}

// GuardDuty

const guardDutyResource = (resource: GuardDuty.Resource | undefined) => {
	const named = (id: string | undefined, name?: string) => ({
		resourceId: id,
		resourceName: name,
	})
	if (resource === undefined) return named(undefined)
	if (resource.InstanceDetails?.InstanceId !== undefined) return named(resource.InstanceDetails.InstanceId)
	if (resource.AccessKeyDetails?.AccessKeyId !== undefined)
		return named(resource.AccessKeyDetails.AccessKeyId, resource.AccessKeyDetails.UserName)
	if (resource.EksClusterDetails?.Name !== undefined) return named(resource.EksClusterDetails.Name)
	if (resource.LambdaDetails?.FunctionName !== undefined) return named(resource.LambdaDetails.FunctionName)
	if (resource.EcsClusterDetails?.Name !== undefined) return named(resource.EcsClusterDetails.Name)
	if (resource.RdsDbInstanceDetails?.DbInstanceIdentifier !== undefined)
		return named(resource.RdsDbInstanceDetails.DbInstanceIdentifier)
	const bucket = Arr.head(resource.S3BucketDetails ?? [])
	if (Option.isSome(bucket) && bucket.value.Name !== undefined) return named(bucket.value.Name)
	if (resource.ContainerDetails?.Id !== undefined)
		return named(resource.ContainerDetails.Id, resource.ContainerDetails.Name)
	return named(undefined)
}

export const normalizeGuardDuty = (finding: GuardDuty.Finding): Option.Option<FindingRead> => {
	if (finding.Id === undefined || finding.Type === undefined) return Option.none()
	return Option.some(
		readFinding({
			findingId: finding.Id,
			type: finding.Type,
			title: finding.Title,
			description: finding.Description,
			severity: cloudFindingSeverityOfScore(finding.Severity ?? 0),
			status: finding.Service?.Archived === true ? "archived" : "active",
			resourceType: finding.Resource?.ResourceType,
			...guardDutyResource(finding.Resource),
			occurrences: finding.Service?.Count,
			firstSeenAt: msOf(finding.Service?.EventFirstSeen ?? finding.CreatedAt),
			lastSeenAt: msOf(finding.Service?.EventLastSeen ?? finding.UpdatedAt),
			updatedAt: msOf(finding.UpdatedAt),
			detail: { arn: finding.Arn, resource: finding.Resource, action: finding.Service?.Action },
		}),
	)
}

/** GuardDuty's ids page 50 at a time; each page's findings are fetched by id. */
const readGuardDuty = (target: ReadTarget) =>
	Effect.gen(function* () {
		const call = callAs(target)
		const detectors = yield* call(
			"GuardDuty.ListDetectors",
			GuardDuty.listDetectors({ region: target.region }),
		)
		const detectorId = Arr.head(detectors.DetectorIds ?? [])
		if (Option.isNone(detectorId))
			return {
				state: "not_enabled",
				findings: [],
				cursorAt: null,
				lastError: null,
			} satisfies RegionRead
		// The first poll reads what is open; later ones every change since the cursor, oldest first.
		const criterion: Record<string, GuardDuty.Condition> =
			target.cursorAt === null
				? { "service.archived": { Equals: ["false"] } }
				: { updatedAt: { GreaterThanOrEqual: target.cursorAt } }
		const read = yield* pagesOf((token) =>
			Effect.gen(function* () {
				const listed = yield* call(
					"GuardDuty.ListFindings",
					GuardDuty.listFindings({
						region: target.region,
						DetectorId: detectorId.value,
						FindingCriteria: { Criterion: criterion },
						SortCriteria: { AttributeName: "updatedAt", OrderBy: "ASC" },
						MaxResults: 50,
						NextToken: token,
					}),
				)
				if (listed.FindingIds.length === 0) return { items: [], next: listed.NextToken }
				const got = yield* call(
					"GuardDuty.GetFindings",
					GuardDuty.getFindings({
						region: target.region,
						DetectorId: detectorId.value,
						FindingIds: listed.FindingIds,
					}),
				)
				return {
					items: Arr.getSomes(Arr.map(got.Findings, normalizeGuardDuty)),
					next: listed.NextToken,
				}
			}),
		)
		return {
			state: "enabled",
			findings: read.items,
			cursorAt: sortedCursor(target, read.items),
			lastError: read.complete
				? null
				: "More findings changed than one poll reads; the next one continues.",
		} satisfies RegionRead
	})

// Security Hub

/** Security Hub also carries GuardDuty, Inspector and Access Analyzer findings, read from them directly. */
const AGGREGATED_PRODUCTS = ["GuardDuty", "Inspector", "IAM Access Analyzer"]

const securityHubStatus = (finding: SecurityHub.AwsSecurityFinding): CloudFindingStatus => {
	if (finding.RecordState === "ARCHIVED") return "resolved"
	if (finding.Compliance?.Status === "PASSED") return "resolved"
	if (finding.Workflow?.Status === "RESOLVED") return "resolved"
	if (finding.Workflow?.Status === "SUPPRESSED") return "archived"
	return "active"
}

export const normalizeSecurityHub = (finding: SecurityHub.AwsSecurityFinding): Option.Option<FindingRead> => {
	if (finding.Id === undefined) return Option.none()
	const resource = Option.getOrUndefined(Arr.head(finding.Resources ?? []))
	return Option.some(
		readFinding({
			findingId: finding.Id,
			type: finding.GeneratorId ?? Option.getOrElse(Arr.head(finding.Types ?? []), () => "Finding"),
			title: finding.Title,
			description: finding.Description,
			severity: cloudFindingSeverityOfLabel(finding.Severity?.Label),
			status: securityHubStatus(finding),
			resourceType: resource?.Type,
			resourceId: resource?.Id,
			resourceName: undefined,
			occurrences: undefined,
			firstSeenAt: msOf(finding.FirstObservedAt ?? finding.CreatedAt),
			lastSeenAt: msOf(finding.LastObservedAt ?? finding.UpdatedAt),
			updatedAt: msOf(finding.UpdatedAt),
			detail: {
				productName: finding.ProductName,
				compliance: finding.Compliance,
				remediation: finding.Remediation,
				resources: finding.Resources,
			},
		}),
	)
}

const readSecurityHub = (target: ReadTarget) =>
	Effect.gen(function* () {
		const call = callAs(target)
		// A region without Security Hub answers DescribeHub with InvalidAccessException.
		yield* call(
			"SecurityHub.DescribeHub",
			SecurityHub.describeHub({ region: target.region }),
			new Set(["InvalidAccessException", "ResourceNotFoundException"]),
		)
		const filters: SecurityHub.AwsSecurityFindingFilters = {
			ProductName: Arr.map(AGGREGATED_PRODUCTS, (name) => ({ Value: name, Comparison: "NOT_EQUALS" })),
			...(target.cursorAt === null
				? { RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }] }
				: { UpdatedAt: [{ Start: DateTime.formatIso(DateTime.makeUnsafe(target.cursorAt)) }] }),
		}
		const read = yield* pagesOf((token) =>
			Effect.map(
				call(
					"SecurityHub.GetFindings",
					SecurityHub.getFindings({
						region: target.region,
						Filters: filters,
						SortCriteria: [{ Field: "UpdatedAt", SortOrder: "asc" }],
						MaxResults: 100,
						NextToken: token,
					}),
				),
				(page) => ({
					items: Arr.getSomes(Arr.map(page.Findings, normalizeSecurityHub)),
					next: page.NextToken,
				}),
			),
		)
		return {
			state: "enabled",
			findings: read.items,
			cursorAt: sortedCursor(target, read.items),
			lastError: read.complete
				? null
				: "More findings changed than one poll reads; the next one continues.",
		} satisfies RegionRead
	})

// Inspector

const inspectorStatus = (status: string): CloudFindingStatus =>
	status === "CLOSED" ? "resolved" : status === "SUPPRESSED" ? "archived" : "active"

export const normalizeInspector = (finding: Inspector.Finding): FindingRead => {
	const resource = Option.getOrUndefined(Arr.head(finding.resources))
	return readFinding({
		findingId: finding.findingArn,
		type: finding.packageVulnerabilityDetails?.vulnerabilityId ?? finding.type,
		title: finding.title,
		description: finding.description,
		severity: cloudFindingSeverityOfLabel(finding.severity),
		status: inspectorStatus(finding.status),
		resourceType: resource?.type,
		resourceId: resource?.id,
		resourceName: undefined,
		occurrences: undefined,
		firstSeenAt: msOf(finding.firstObservedAt),
		lastSeenAt: msOf(finding.lastObservedAt),
		updatedAt: msOf(finding.updatedAt ?? finding.lastObservedAt),
		detail: {
			findingType: finding.type,
			inspectorScore: finding.inspectorScore,
			fixAvailable: finding.fixAvailable,
			exploitAvailable: finding.exploitAvailable,
			remediation: finding.remediation,
			packageVulnerabilityDetails: finding.packageVulnerabilityDetails,
		},
	})
}

const readInspector = (target: ReadTarget) =>
	Effect.gen(function* () {
		const call = callAs(target)
		const status = yield* call(
			"Inspector.BatchGetAccountStatus",
			Inspector.batchGetAccountStatus({ region: target.region, accountIds: [target.accountId] }),
		)
		const account = Arr.findFirst(status.accounts, (state) => state.accountId === target.accountId)
		if (Option.isNone(account) || account.value.state.status !== "ENABLED") {
			return {
				state: "not_enabled",
				findings: [],
				cursorAt: null,
				lastError: null,
			} satisfies RegionRead
		}
		const filterCriteria: Inspector.FilterCriteria =
			target.cursorAt === null
				? { findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }] }
				: { updatedAt: [{ startInclusive: DateTime.toDate(DateTime.makeUnsafe(target.cursorAt)) }] }
		const read = yield* pagesOf((token) =>
			Effect.map(
				call(
					"Inspector.ListFindings",
					Inspector.listFindings({
						region: target.region,
						filterCriteria,
						maxResults: 100,
						nextToken: token,
					}),
				),
				(page) => ({ items: Arr.map(page.findings ?? [], normalizeInspector), next: page.nextToken }),
			),
		)
		// Inspector cannot sort by update time, so the cursor moves only once a read is complete.
		return {
			state: "enabled",
			findings: read.items,
			cursorAt: read.complete ? sortedCursor(target, read.items) : null,
			lastError: read.complete
				? null
				: "More findings changed than one poll reads; the next one reads them again.",
		} satisfies RegionRead
	})

// IAM Access Analyzer

const accessAnalyzerTitle = (findingType: string): string => {
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

const accessAnalyzerSeverity = (findingType: string): CloudFindingSeverity =>
	findingType === "ExternalAccess" ? "high" : findingType === "InternalAccess" ? "medium" : "low"

const accessAnalyzerStatus = (status: string): CloudFindingStatus =>
	status === "RESOLVED" ? "resolved" : status === "ARCHIVED" ? "archived" : "active"

export const normalizeAccessAnalyzer = (finding: AccessAnalyzer.FindingSummaryV2): FindingRead => {
	const findingType = finding.findingType ?? "ExternalAccess"
	return readFinding({
		findingId: finding.id,
		type: findingType,
		title: accessAnalyzerTitle(findingType),
		description: finding.error,
		severity: accessAnalyzerSeverity(findingType),
		status: accessAnalyzerStatus(finding.status),
		resourceType: finding.resourceType,
		resourceId: finding.resource,
		resourceName: undefined,
		occurrences: undefined,
		firstSeenAt: msOf(finding.createdAt),
		lastSeenAt: msOf(finding.analyzedAt),
		updatedAt: msOf(finding.updatedAt),
		detail: { resourceOwnerAccount: finding.resourceOwnerAccount },
	})
}

/** Access Analyzer findings are few and cannot be filtered by update time: every poll reads them all. */
const readAccessAnalyzer = (target: ReadTarget) =>
	Effect.gen(function* () {
		const call = callAs(target)
		const listed = yield* call(
			"AccessAnalyzer.ListAnalyzers",
			AccessAnalyzer.listAnalyzers({ region: target.region }),
		)
		const active = Arr.filter(listed.analyzers, (analyzer) => analyzer.status === "ACTIVE")
		if (active.length === 0)
			return {
				state: "not_enabled",
				findings: [],
				cursorAt: null,
				lastError: null,
			} satisfies RegionRead
		const reads = yield* Effect.forEach(active, (analyzer) =>
			pagesOf((token) =>
				Effect.map(
					call(
						"AccessAnalyzer.ListFindingsV2",
						AccessAnalyzer.listFindingsV2({
							region: target.region,
							analyzerArn: analyzer.arn,
							maxResults: 100,
							nextToken: token,
						}),
					),
					(page) => ({
						items: Arr.map(page.findings, normalizeAccessAnalyzer),
						next: page.nextToken,
					}),
				),
			),
		)
		const findings = Arr.flatMap(reads, (read) => read.items)
		const complete = Arr.every(reads, (read) => read.complete)
		return {
			state: "enabled",
			findings,
			cursorAt: sortedCursor(target, findings),
			lastError: complete ? null : "This account has more findings than one poll reads.",
		} satisfies RegionRead
	})

const READERS = {
	guardduty: readGuardDuty,
	securityhub: readSecurityHub,
	inspector: readInspector,
	access_analyzer: readAccessAnalyzer,
} satisfies Record<
	CloudFindingSource,
	(target: ReadTarget) => Effect.Effect<RegionRead, AwsSecurityReadError>
>

/** One service in one region. A failure is the state it leaves, never an error. */
export const readSource = (source: CloudFindingSource, target: ReadTarget): Effect.Effect<RegionRead> =>
	READERS[source](target).pipe(
		Effect.catchTag("@maple/backend/cloud-security/AwsSecurityReadError", (error) =>
			Effect.succeed({
				state: error.kind,
				findings: [],
				cursorAt: null,
				lastError: error.kind === "not_enabled" ? null : error.message,
			} satisfies RegionRead),
		),
		Effect.withSpan("AwsSecurity.readSource", {
			attributes: { "maple.aws.region": target.region, "maple.cloud_security.source": source },
		}),
	)

/** The regions enabled in the account, as `account:ListRegions` lists them. */
export const enabledRegions = (
	httpClient: HttpClient.HttpClient,
	session: AwsRoleSession,
): Effect.Effect<ReadonlyArray<AwsRegion>, AwsSecurityReadError> => {
	const call = callAs({
		httpClient,
		session,
		accountId: "",
		region: Schema.decodeSync(AwsRegion)("us-east-1"),
		cursorAt: null,
	})
	return Effect.map(
		pagesOf((token) =>
			Effect.map(
				call(
					"Account.ListRegions",
					Account.listRegions({
						RegionOptStatusContains: ["ENABLED", "ENABLED_BY_DEFAULT"],
						MaxResults: 50,
						NextToken: token,
					}),
				),
				(page) => ({ items: page.Regions ?? [], next: page.NextToken }),
			),
		),
		(read) =>
			Arr.filter(
				Arr.getSomes(Arr.map(read.items, (region) => Option.fromUndefinedOr(region.RegionName))),
				isRegion,
			),
	)
}

// CloudTrail

/** CloudTrail lists an event up to about 15 minutes after it happened: each read reaches back past that. */
export const CLOUDTRAIL_LATE_MS = 20 * 60 * 1000
/** How far back the first read of a region goes. */
export const CLOUDTRAIL_BACKFILL_MS = 24 * 60 * 60 * 1000

export interface CloudTrailRead {
	readonly state: CloudServiceState
	readonly events: ReadonlyArray<AuditTrailEvent>
	readonly cursorAt: number | null
	readonly lastError: string | null
}

/**
 * The region's write management events since the cursor, less the late margin. Reads overlap, and
 * an event read twice lands on the same audit trail key.
 */
export const readCloudTrail = (target: ReadTarget, nowMs: number): Effect.Effect<CloudTrailRead> => {
	const call = callAs(target)
	const startMs = Num.max(nowMs - CLOUDTRAIL_BACKFILL_MS, (target.cursorAt ?? 0) - CLOUDTRAIL_LATE_MS)
	return pagesOf((token) =>
		Effect.map(
			call(
				"CloudTrail.LookupEvents",
				CloudTrail.lookupEvents({
					region: target.region,
					LookupAttributes: [{ AttributeKey: "ReadOnly", AttributeValue: "false" }],
					StartTime: DateTime.toDate(DateTime.makeUnsafe(startMs)),
					EndTime: DateTime.toDate(DateTime.makeUnsafe(nowMs)),
					MaxResults: 50,
					NextToken: token,
				}),
			),
			(page) => ({ items: page.Events ?? [], next: page.NextToken }),
		),
	).pipe(
		Effect.map((read): CloudTrailRead => ({
			state: "enabled",
			events: Arr.getSomes(
				Arr.map(read.items, (event) => cloudTrailAuditEvent(target.accountId, event)),
			),
			// Newest first: a read cut short keeps the cursor and reads the window again.
			cursorAt: read.complete ? nowMs : null,
			lastError: read.complete ? null : "More changes than one poll reads; the oldest may be missed.",
		})),
		Effect.catchTag("@maple/backend/cloud-security/AwsSecurityReadError", (error) =>
			Effect.succeed({
				state: error.kind,
				events: [],
				cursorAt: null,
				lastError: error.message,
			} satisfies CloudTrailRead),
		),
		Effect.withSpan("AwsSecurity.readCloudTrail", { attributes: { "maple.aws.region": target.region } }),
	)
}
