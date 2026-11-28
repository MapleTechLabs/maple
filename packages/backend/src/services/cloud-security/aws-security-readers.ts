/**
 * Reads one AWS security service in one region with an assumed-role session. A reader hands each
 * page of findings to a sink as it reads it and answers with the service's state there and the
 * next cursor. Owns the SDK imports, so `AwsSecurityFindingsService` loads it with the first poll.
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
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import {
	type AwsFindingSource,
	type CloudServiceState,
	cloudFindingSeverityOfLabel,
	cloudFindingSeverityOfScore,
} from "@maple/domain/cloud-security"
import { AwsRegion } from "@maple/primitives"
import {
	Array as Arr,
	Clock,
	DateTime,
	Duration,
	Effect,
	Number as Num,
	Option,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { HttpClient } from "effect/http"
import type { AwsRoleSession } from "../integrations/aws/api"
import { cloudTrailAuditEvent } from "./cloudtrail-events"
import {
	AGGREGATED_PRODUCTS,
	accessAnalyzerSeverity,
	accessAnalyzerStatus,
	accessAnalyzerTitle,
	type FindingRead,
	inspectorStatus,
	msOf,
	readFinding,
	securityHubStatus,
} from "./finding-read"

export type { FindingRead } from "./finding-read"

const REQUEST_TIMEOUT = Duration.seconds(20)
const RETRY: Retry.Options = {
	while: Category.isTransientError,
	backoff: { baseMs: 500, factor: 2, capMs: 2000, maxRetries: 2, jitterMs: 50 },
}
/** Pages one feed reads in one region per poll; a poll past it resumes from the cursor next time. */
export const MAX_PAGES = 20
/** Pages one time window may take before it is split in half. */
export const WINDOW_PAGES = 5

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

const DENIED_CODES = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation"])
const isRegion = Schema.is(AwsRegion)

/** A read that stopped: `denied` is the role, anything else is AWS. */
export class AwsSecurityReadError extends Schema.TaggedError<AwsSecurityReadError>()(
	"@maple/backend/cloud-security/AwsSecurityReadError",
	{
		message: Schema.String,
		kind: Schema.Literals(["denied", "not_enabled", "failing"]),
	},
) {}

const isReadError = Schema.is(AwsSecurityReadError)

/** Where a reader hands each page as it reads it, so a read never holds more than a page. */
export type Sink<A, E> = (items: ReadonlyArray<A>) => Effect.Effect<void, E>

export interface RegionRead {
	readonly state: CloudServiceState
	readonly findings: number
	/** The cursor to store; null keeps the stored one. */
	readonly cursorAt: number | null
	/** Why the read stopped short, or why the service is not readable. */
	readonly lastError: string | null
	/** Every id a complete read of a service read whole returned; null when the read was not whole. */
	readonly seenIds: ReadonlyArray<string> | null
	/** For a windowed read: the window size the next poll starts with; null keeps the stored one. */
	readonly windowMs: number | null
}

export interface ReadTarget {
	readonly httpClient: HttpClient.HttpClient
	readonly session: AwsRoleSession
	readonly accountId: string
	readonly region: AwsRegion
	/** The stored cursor: how far earlier reads got. Null on the first poll. */
	readonly cursorAt: number | null
	/** The window size the last windowed read ended on. Null before one. */
	readonly windowMs: number | null
	readonly nowMs: number
	/** A read starts no page past this; what is left waits for the next poll. */
	readonly deadlineMs: number
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
	(target: {
		readonly httpClient: HttpClient.HttpClient
		readonly session: AwsRoleSession
		readonly region: AwsRegion
	}) =>
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
				Effect.withSpan("AwsSecurity.call", {
					kind: "client",
					attributes: {
						"peer.service": "aws",
						"maple.aws.region": target.region,
						"maple.aws.operation": what,
					},
				}),
			)
		})

interface PagesRead {
	readonly count: number
	readonly pages: number
	readonly complete: boolean
	/** For a newest-first listing: the oldest item time the pages reached. */
	readonly oldestMs?: number
}

type Page<A> = Effect.Effect<
	{ readonly items: ReadonlyArray<A>; readonly next: string | undefined },
	AwsSecurityReadError
>

/**
 * Pages of a listing, each handed to `onPage`, until it ends, `maxPages`, or the deadline passes
 * between two pages; `complete` says whether it ended.
 */
const pagesOf = <A, E>(
	page: (token: string | undefined) => Page<A>,
	onPage: Sink<A, E>,
	maxPages: number,
	deadlineMs: number,
): Effect.Effect<PagesRead, AwsSecurityReadError | E> => {
	const go = (
		token: string | undefined,
		count: number,
		pages: number,
	): Effect.Effect<PagesRead, AwsSecurityReadError | E> =>
		Effect.flatMap(page(token), ({ items, next }) =>
			Effect.flatMap(onPage(items), () => {
				const read = { count: count + items.length, pages: pages + 1 }
				if (next === undefined || next === "") return Effect.succeed({ ...read, complete: true })
				if (read.pages >= maxPages) return Effect.succeed({ ...read, complete: false })
				return Effect.flatMap(Clock.currentTimeMillis, (now) =>
					now >= deadlineMs
						? Effect.succeed({ ...read, complete: false })
						: go(next, read.count, read.pages),
				)
			}),
		)
	return go(undefined, 0, 0)
}

interface WindowsRead {
	/** Where the next read starts: the end of the last whole window. */
	readonly cursorAt: number
	readonly count: number
	readonly caughtUp: boolean
	/** A smallest window held more than every page left, and the rest of it was skipped. */
	readonly skipped: boolean
	/** The span the next read starts with, so splitting a dense spot carries over between polls. */
	readonly spanMs: number
}

/** The smallest window: both services keep their times to the second. */
const MIN_WINDOW_MS = 1000

/**
 * Reads `[startMs, endMs]` oldest window first, for listings that cannot sort by time. A whole window
 * moves the cursor past it and doubles the next span. One that fills `WINDOW_PAGES` is read again
 * smaller: sized from the oldest item it reached when the listing is newest first, an eighth otherwise.
 * The span is kept with the cursor, so a poll either moves the cursor or narrows the span, and a dense
 * spot is never split from scratch twice. A one-second window gets every page left; past that it is skipped.
 */
const readWindows = <E>(
	plan: {
		readonly startMs: number
		readonly endMs: number
		readonly spanMs: number
		readonly maxSpanMs: number
		readonly budgetPages: number
		readonly deadlineMs: number
	},
	readWindow: (
		fromMs: number,
		toMs: number,
		maxPages: number,
	) => Effect.Effect<PagesRead, AwsSecurityReadError | E>,
): Effect.Effect<WindowsRead, AwsSecurityReadError | E> => {
	const go = (
		from: number,
		span: number,
		ceiling: number,
		pagesLeft: number,
		count: number,
		skipped: boolean,
	): Effect.Effect<WindowsRead, AwsSecurityReadError | E> => {
		if (from >= plan.endMs)
			return Effect.succeed({ cursorAt: plan.endMs, count, caughtUp: true, skipped, spanMs: span })
		const stop = { cursorAt: from, count, caughtUp: false, skipped, spanMs: span }
		if (pagesLeft <= 0) return Effect.succeed(stop)
		return Effect.flatMap(Clock.currentTimeMillis, (now) => {
			if (now >= plan.deadlineMs) return Effect.succeed(stop)
			const to = Num.min(plan.endMs, from + span)
			const width = to - from
			const smallest = width <= MIN_WINDOW_MS
			const allowed = smallest ? pagesLeft : Num.min(WINDOW_PAGES, pagesLeft)
			return Effect.flatMap(readWindow(from, to, allowed), (read) => {
				const left = pagesLeft - read.pages
				const total = count + read.count
				if (read.complete) return go(to, Num.min(ceiling, span * 2), ceiling, left, total, skipped)
				if (smallest) {
					// A whole poll's pages went to one second and it still had more: skip the rest of it.
					if (read.pages >= plan.budgetPages)
						return go(to, MIN_WINDOW_MS, plan.maxSpanMs, left, total, true)
					// Fewer pages were left than a poll has: the next poll gives this second every page.
					return Effect.succeed({ ...stop, count: total, spanMs: MIN_WINDOW_MS })
				}
				// The budget or the deadline ran out inside the window: the next poll reads it again.
				if (read.pages < WINDOW_PAGES) return Effect.succeed({ ...stop, count: total })
				const fitted =
					read.oldestMs === undefined || read.oldestMs <= from
						? Math.floor(width / 8)
						: Math.floor((to - read.oldestMs) * 0.8)
				const next = Num.max(MIN_WINDOW_MS, Num.min(fitted, Math.floor(width / 2)))
				// Growing back stops short of the window that was too full.
				return go(from, next, Num.max(next, Math.floor(width / 2)), left, total, skipped)
			})
		})
	}
	const span = Num.min(plan.maxSpanMs, Num.max(MIN_WINDOW_MS, plan.spanMs))
	return go(plan.startMs, span, plan.maxSpanMs, plan.budgetPages, 0, false)
}

const windowsError = (read: WindowsRead, noun: string): string | null => {
	if (read.skipped)
		return `More ${noun} in one second than one poll reads; the rest of that second was skipped.`
	return read.caughtUp ? null : "Catching up: the next poll continues."
}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))
const dateOf = (ms: number) => DateTime.toDate(DateTime.makeUnsafe(ms))

/** `effect`'s answer with the time it arrived: no finding in it is dated later than that. */
const mapAt = <A, E, R, B>(effect: Effect.Effect<A, E, R>, f: (answer: A, nowMs: number) => B) =>
	Effect.zipWith(effect, Clock.currentTimeMillis, f)

/** A sink that also keeps the newest update time it passed on, for readers sorted by it. */
const trackingNewest = <E>(sink: Sink<FindingRead, E>) =>
	Effect.map(Ref.make<number | null>(null), (newest) => ({
		newest,
		sink: (findings: ReadonlyArray<FindingRead>) =>
			Effect.andThen(
				Ref.update(newest, (current) =>
					Arr.reduce(findings, current, (max: number | null, finding) =>
						max === null ? finding.providerUpdatedAt : Num.max(max, finding.providerUpdatedAt),
					),
				),
				sink(findings),
			),
	}))

/**
 * Where a read sorted by update time leaves the cursor: at the newest read, never behind the stored
 * one. A capped read that got no further than the stored instant holds more findings at that one
 * time than a poll reads: it steps past the instant rather than read the same pages forever.
 */
const sortedProgress = (
	target: ReadTarget,
	newest: number | null,
	complete: boolean,
): { readonly cursorAt: number | null; readonly lastError: string | null } => {
	if (complete)
		return { cursorAt: newest === null ? null : Num.max(newest, target.cursorAt ?? 0), lastError: null }
	if (newest !== null && target.cursorAt !== null && newest <= target.cursorAt) {
		return {
			cursorAt: target.cursorAt + 1,
			lastError:
				"More findings share one update time than a poll reads; the rest of that instant was skipped.",
		}
	}
	return { cursorAt: newest === null ? null : Num.max(newest, target.cursorAt ?? 0), lastError: CAPPED }
}

const notEnabled: RegionRead = {
	state: "not_enabled",
	findings: 0,
	cursorAt: null,
	lastError: null,
	seenIds: null,
	windowMs: null,
}

const CAPPED = "More findings changed than one poll reads; the next one continues."

// GuardDuty

const guardDutyResource = (resource: GuardDuty.Resource | undefined) => {
	const named = (id: string | undefined, name?: string) => ({ resourceId: id, resourceName: name })
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

export const normalizeGuardDuty = (finding: GuardDuty.Finding, nowMs: number): Option.Option<FindingRead> => {
	if (finding.Id === undefined || finding.Type === undefined) return Option.none()
	return readFinding(
		{
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
		},
		nowMs,
	)
}

const guardDutyDetector = (target: ReadTarget) =>
	Effect.map(
		callAs(target)("GuardDuty.ListDetectors", GuardDuty.listDetectors({ region: target.region })),
		(listed) => Arr.head(listed.DetectorIds ?? []),
	)

const guardDutyFindings = (target: ReadTarget, detectorId: string, ids: ReadonlyArray<string>) =>
	mapAt(
		callAs(target)(
			"GuardDuty.GetFindings",
			GuardDuty.getFindings({
				region: target.region,
				DetectorId: detectorId,
				FindingIds: Arr.fromIterable(ids),
			}),
		),
		(got, nowMs) => Arr.getSomes(Arr.map(got.Findings, (finding) => normalizeGuardDuty(finding, nowMs))),
	)

/** GuardDuty's ids page 50 at a time, oldest update first; each page's findings are fetched by id. */
const readGuardDuty = <E>(target: ReadTarget, sink: Sink<FindingRead, E>) =>
	Effect.gen(function* () {
		const detectorId = yield* guardDutyDetector(target)
		if (Option.isNone(detectorId)) return notEnabled
		// A delegated administrator lists its members' findings too: only this account's are read.
		const criterion = {
			accountId: { Equals: [target.accountId] },
			...(target.cursorAt === null
				? { "service.archived": { Equals: ["false"] } }
				: { updatedAt: { GreaterThanOrEqual: target.cursorAt } }),
		} satisfies Record<string, GuardDuty.Condition>
		const tracked = yield* trackingNewest(sink)
		const read = yield* pagesOf(
			(token) =>
				Effect.gen(function* () {
					const listed = yield* callAs(target)(
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
					const items =
						listed.FindingIds.length === 0
							? []
							: yield* guardDutyFindings(target, detectorId.value, listed.FindingIds)
					return { items, next: listed.NextToken }
				}),
			tracked.sink,
			MAX_PAGES,
			target.deadlineMs,
		)
		const newest = yield* Ref.get(tracked.newest)
		return {
			state: "enabled",
			findings: read.count,
			...sortedProgress(target, newest, read.complete),
			seenIds: null,
			windowMs: null,
		} satisfies RegionRead
	})

// Security Hub

export const normalizeSecurityHub = (
	finding: SecurityHub.AwsSecurityFinding,
	nowMs: number,
): Option.Option<FindingRead> => {
	if (finding.Id === undefined) return Option.none()
	const resource = Option.getOrUndefined(Arr.head(finding.Resources ?? []))
	return readFinding(
		{
			findingId: finding.Id,
			type: finding.GeneratorId ?? Option.getOrElse(Arr.head(finding.Types ?? []), () => "Finding"),
			title: finding.Title,
			description: finding.Description,
			severity: cloudFindingSeverityOfLabel(finding.Severity?.Label),
			status: securityHubStatus({
				recordState: finding.RecordState,
				complianceStatus: finding.Compliance?.Status,
				workflowStatus: finding.Workflow?.Status,
			}),
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
		},
		nowMs,
	)
}

/** This account's findings in this region, not an aggregation region's or an administrator's members'. */
const securityHubScope = (target: ReadTarget): SecurityHub.AwsSecurityFindingFilters => ({
	ProductName: Arr.map(AGGREGATED_PRODUCTS, (name) => ({ Value: name, Comparison: "NOT_EQUALS" })),
	AwsAccountId: [{ Value: target.accountId, Comparison: "EQUALS" }],
	Region: [{ Value: target.region, Comparison: "EQUALS" }],
})

const readSecurityHub = <E>(target: ReadTarget, sink: Sink<FindingRead, E>) =>
	Effect.gen(function* () {
		// A region without Security Hub answers DescribeHub with InvalidAccessException.
		yield* callAs(target)(
			"SecurityHub.DescribeHub",
			SecurityHub.describeHub({ region: target.region }),
			new Set(["InvalidAccessException", "ResourceNotFoundException"]),
		)
		// The first read takes what is open and not passing; a passed control would only be stored closed.
		const filters: SecurityHub.AwsSecurityFindingFilters = {
			...securityHubScope(target),
			...(target.cursorAt === null
				? {
						RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
						ComplianceStatus: [{ Value: "PASSED", Comparison: "NOT_EQUALS" }],
					}
				: { UpdatedAt: [{ Start: isoOf(target.cursorAt), End: isoOf(target.nowMs) }] }),
		}
		const tracked = yield* trackingNewest(sink)
		const read = yield* pagesOf(
			(token) =>
				mapAt(
					callAs(target)(
						"SecurityHub.GetFindings",
						SecurityHub.getFindings({
							region: target.region,
							Filters: filters,
							SortCriteria: [{ Field: "UpdatedAt", SortOrder: "asc" }],
							MaxResults: 100,
							NextToken: token,
						}),
					),
					(page, nowMs) => ({
						items: Arr.getSomes(
							Arr.map(page.Findings, (finding) => normalizeSecurityHub(finding, nowMs)),
						),
						next: page.NextToken,
					}),
				),
			tracked.sink,
			MAX_PAGES,
			target.deadlineMs,
		)
		const newest = yield* Ref.get(tracked.newest)
		return {
			state: "enabled",
			findings: read.count,
			...sortedProgress(target, newest, read.complete),
			seenIds: null,
			windowMs: null,
		} satisfies RegionRead
	})

// Inspector

export const normalizeInspector = (finding: Inspector.Finding, nowMs: number): Option.Option<FindingRead> => {
	const resource = Option.getOrUndefined(Arr.head(finding.resources))
	return readFinding(
		{
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
		},
		nowMs,
	)
}

/**
 * Inspector keeps an open finding until it is fixed, however old: the first read starts at
 * Inspector's launch (November 2021), so no open finding falls before it.
 */
export const INSPECTOR_EPOCH_MS = Date.UTC(2021, 10, 1)
/** Inspector's update index lags a little: a read stops this far short of now. Late listings meet the refresh by id. */
const INSPECTOR_LATE_MS = 5 * MINUTE_MS

/** Inspector cannot sort by update time, so it is read in update-time windows, oldest first. */
const readInspector = <E>(target: ReadTarget, sink: Sink<FindingRead, E>) =>
	Effect.gen(function* () {
		const status = yield* callAs(target)(
			"Inspector.BatchGetAccountStatus",
			Inspector.batchGetAccountStatus({ region: target.region, accountIds: [target.accountId] }),
		)
		const account = Arr.findFirst(status.accounts, (state) => state.accountId === target.accountId)
		if (Option.isNone(account) || account.value.state.status !== "ENABLED") return notEnabled
		const endMs = target.nowMs - INSPECTOR_LATE_MS
		const read = yield* readWindows(
			{
				startMs: target.cursorAt ?? INSPECTOR_EPOCH_MS,
				endMs,
				// The first read tries everything since the epoch at once; a full window splits itself.
				spanMs:
					target.cursorAt === null
						? endMs - INSPECTOR_EPOCH_MS
						: (target.windowMs ?? 60 * MINUTE_MS),
				maxSpanMs: target.cursorAt === null ? endMs - INSPECTOR_EPOCH_MS : 90 * DAY_MS,
				budgetPages: MAX_PAGES,
				deadlineMs: target.deadlineMs,
			},
			(fromMs, toMs, maxPages) =>
				pagesOf(
					(token) =>
						mapAt(
							callAs(target)(
								"Inspector.ListFindings",
								Inspector.listFindings({
									region: target.region,
									filterCriteria: {
										awsAccountId: [{ comparison: "EQUALS", value: target.accountId }],
										updatedAt: [
											{ startInclusive: dateOf(fromMs), endInclusive: dateOf(toMs) },
										],
									},
									maxResults: 100,
									nextToken: token,
								}),
							),
							(page, nowMs) => ({
								items: Arr.getSomes(
									Arr.map(page.findings ?? [], (finding) =>
										normalizeInspector(finding, nowMs),
									),
								),
								next: page.nextToken,
							}),
						),
					sink,
					maxPages,
					target.deadlineMs,
				),
		)
		return {
			state: "enabled",
			findings: read.count,
			cursorAt: read.cursorAt,
			lastError: windowsError(read, "findings changed"),
			seenIds: null,
			windowMs: read.spanMs,
		} satisfies RegionRead
	})

// IAM Access Analyzer

export const normalizeAccessAnalyzer = (
	finding: AccessAnalyzer.FindingSummaryV2,
	nowMs: number,
): Option.Option<FindingRead> => {
	const findingType = finding.findingType ?? "ExternalAccess"
	return readFinding(
		{
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
		},
		nowMs,
	)
}

/**
 * Access Analyzer cannot filter by update time, so every poll reads its findings newest change
 * first. A whole read names every id it saw, and the poller resolves the stored ones it did not.
 */
const readAccessAnalyzer = <E>(target: ReadTarget, sink: Sink<FindingRead, E>) =>
	Effect.gen(function* () {
		const call = callAs(target)
		const analyzers = yield* Ref.make<ReadonlyArray<AccessAnalyzer.AnalyzerSummary>>([])
		const listing = yield* pagesOf(
			(token) =>
				Effect.map(
					call(
						"AccessAnalyzer.ListAnalyzers",
						AccessAnalyzer.listAnalyzers({ region: target.region, nextToken: token }),
					),
					(page) => ({ items: page.analyzers, next: page.nextToken }),
				),
			(page) => Ref.update(analyzers, (seen) => Arr.appendAll(seen, page)),
			MAX_PAGES,
			target.deadlineMs,
		)
		const listed = { analyzers: yield* Ref.get(analyzers) }
		const active = Arr.filter(listed.analyzers, (analyzer) => analyzer.status === "ACTIVE")
		// A listing the deadline cut short says nothing about analyzers it did not reach.
		if (active.length === 0 && !listing.complete) {
			return yield* new AwsSecurityReadError({
				message: "AccessAnalyzer.ListAnalyzers: the listing was cut short",
				kind: "failing",
			})
		}
		if (listed.analyzers.length === 0) return notEnabled
		// Analyzers that exist but are still being created, or failed, are not "off": ask again next poll.
		if (active.length === 0) {
			return yield* new AwsSecurityReadError({
				message: `AccessAnalyzer: no analyzer is active yet (${Arr.join(Arr.dedupe(Arr.map(listed.analyzers, (analyzer) => analyzer.status)), ", ")})`,
				kind: "failing",
			})
		}
		const seen = yield* Ref.make<ReadonlyArray<string>>([])
		const reads = yield* Effect.forEach(active, (analyzer) =>
			pagesOf(
				(token) =>
					mapAt(
						call(
							"AccessAnalyzer.ListFindingsV2",
							AccessAnalyzer.listFindingsV2({
								region: target.region,
								analyzerArn: analyzer.arn,
								// Newest change first, resolutions included: a capped read still sees every
								// recent change, and only a whole read resolves by absence.
								filter: {
									status: { eq: ["ACTIVE", "ARCHIVED", "RESOLVED"] },
									resourceOwnerAccount: { eq: [target.accountId] },
								},
								sort: { attributeName: "UpdatedAt", orderBy: "DESC" },
								maxResults: 100,
								nextToken: token,
							}),
						),
						(page, nowMs) => ({
							items: Arr.getSomes(
								Arr.map(page.findings, (finding) => normalizeAccessAnalyzer(finding, nowMs)),
							),
							next: page.nextToken,
						}),
					),
				(findings) =>
					Effect.andThen(
						Ref.update(seen, (ids) =>
							Arr.appendAll(
								ids,
								Arr.map(findings, (finding) => finding.findingId),
							),
						),
						sink(findings),
					),
				MAX_PAGES,
				target.deadlineMs,
			),
		)
		// An analyzer still being created, or failed, holds findings this read did not see.
		const complete =
			listing.complete &&
			Arr.every(reads, (read) => read.complete) &&
			active.length === listed.analyzers.length
		const seenIds = yield* Ref.get(seen)
		return {
			state: "enabled",
			findings: Arr.reduce(reads, 0, (total, read) => total + read.count),
			cursorAt: target.nowMs,
			lastError: complete ? null : "This account has more findings than one poll reads.",
			seenIds: complete ? seenIds : null,
			windowMs: null,
		} satisfies RegionRead
	})

/** One service in one region. An AWS failure is the state it leaves; only the sink's errors fail it. */
export const readSource = <E>(
	source: AwsFindingSource,
	target: ReadTarget,
	sink: Sink<FindingRead, E>,
): Effect.Effect<RegionRead, E> => {
	const read = (): Effect.Effect<RegionRead, AwsSecurityReadError | E> => {
		switch (source) {
			case "guardduty":
				return readGuardDuty(target, sink)
			case "securityhub":
				return readSecurityHub(target, sink)
			case "inspector":
				return readInspector(target, sink)
			case "access_analyzer":
				return readAccessAnalyzer(target, sink)
		}
	}
	return read().pipe(
		Effect.catchIf(isReadError, (error) =>
			Effect.succeed({
				state: error.kind,
				findings: 0,
				cursorAt: null,
				lastError: error.kind === "not_enabled" ? null : error.message,
				seenIds: null,
				windowMs: null,
			} satisfies RegionRead),
		),
		Effect.withSpan("AwsSecurity.readSource", {
			attributes: { "maple.aws.region": target.region, "maple.cloud_security.source": source },
		}),
	)
}

// Reconcile

/** Security Hub takes this many values for one filter field. */
const SECURITY_HUB_ID_BATCH = 20
/** Inspector takes this many values for one string filter. */
const INSPECTOR_ID_BATCH = 10

/**
 * The current version of stored findings, by id: a status changed in the console does not always
 * move the service's update time. `missing` are ids the service no longer has.
 */
/**
 * `fetch` over `ids` in batches, one after another, starting none past `deadlineMs`. `queried` are
 * the ids a batch asked about: only those can be missing.
 */
export const batchesBefore = <A, E>(
	ids: ReadonlyArray<string>,
	size: number,
	deadlineMs: number,
	fetch: (chunk: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<A>, E>,
): Effect.Effect<{ readonly found: ReadonlyArray<A>; readonly queried: ReadonlyArray<string> }, E> =>
	Effect.map(
		Effect.forEach(Arr.chunksOf(ids, size), (chunk) =>
			Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
				nowMs >= deadlineMs
					? Effect.succeedNone
					: Effect.map(fetch(chunk), (found) => Option.some({ found, chunk })),
			),
		),
		(batches) => {
			const done = Arr.getSomes(batches)
			return {
				found: Arr.flatMap(done, (batch) => batch.found),
				queried: Arr.flatMap(done, (batch) => batch.chunk),
			}
		},
	)

export const refreshFindings = (
	source: "guardduty" | "securityhub" | "inspector",
	target: ReadTarget,
	ids: ReadonlyArray<string>,
): Effect.Effect<{
	readonly found: ReadonlyArray<FindingRead>
	readonly missing: ReadonlyArray<string>
}> => {
	type Fetched = { readonly found: ReadonlyArray<FindingRead>; readonly queried: ReadonlyArray<string> }
	const batches = (
		size: number,
		fetchChunk: (
			chunk: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyArray<FindingRead>, AwsSecurityReadError>,
	) => batchesBefore(ids, size, target.deadlineMs, fetchChunk)
	const fetch: Effect.Effect<Fetched, AwsSecurityReadError> =
		source === "inspector"
			? batches(INSPECTOR_ID_BATCH, (chunk) =>
					mapAt(
						callAs(target)(
							"Inspector.ListFindings",
							Inspector.listFindings({
								region: target.region,
								filterCriteria: {
									awsAccountId: [{ comparison: "EQUALS", value: target.accountId }],
									findingArn: Arr.map(chunk, (id) => ({ comparison: "EQUALS", value: id })),
								},
								maxResults: 100,
							}),
						),
						(page, nowMs) =>
							Arr.getSomes(
								Arr.map(page.findings ?? [], (finding) => normalizeInspector(finding, nowMs)),
							),
					),
				)
			: source === "guardduty"
				? Effect.flatMap(guardDutyDetector(target), (detectorId) =>
						Option.isNone(detectorId)
							? Effect.succeed<Fetched>({ found: [], queried: [] })
							: batches(50, (chunk) => guardDutyFindings(target, detectorId.value, chunk)),
					)
				: batches(SECURITY_HUB_ID_BATCH, (chunk) =>
						mapAt(
							callAs(target)(
								"SecurityHub.GetFindings",
								SecurityHub.getFindings({
									region: target.region,
									Filters: {
										...securityHubScope(target),
										Id: Arr.map(chunk, (id) => ({ Value: id, Comparison: "EQUALS" })),
									},
									MaxResults: 100,
								}),
							),
							(page, nowMs) =>
								Arr.getSomes(
									Arr.map(page.Findings, (finding) => normalizeSecurityHub(finding, nowMs)),
								),
						),
					)
	return fetch.pipe(
		Effect.map(({ found, queried }) => {
			const present = new Set(Arr.map(found, (finding) => finding.findingId))
			return { found, missing: Arr.filter(queried, (id) => !present.has(id)) }
		}),
		// A refresh that fails changes nothing; the next one tries the same rows again. It still says why.
		Effect.catchTag("@maple/backend/cloud-security/AwsSecurityReadError", (error) =>
			Effect.logWarning("AWS security refresh by id failed").pipe(
				Effect.annotateLogs({
					source,
					region: target.region,
					kind: error.kind,
					error: error.message,
				}),
				Effect.andThen(
					Effect.annotateCurrentSpan({
						"error.type": error.kind,
						"maple.cloud_security.refresh_error": error.message,
					}),
				),
				Effect.as({ found: [], missing: [] }),
			),
		),
		Effect.withSpan("AwsSecurity.refreshFindings", {
			attributes: { "maple.aws.region": target.region, "maple.cloud_security.source": source },
		}),
	)
}

/** The regions enabled in the account, as `account:ListRegions` lists them. */
export const enabledRegions = (
	httpClient: HttpClient.HttpClient,
	session: AwsRoleSession,
): Effect.Effect<ReadonlyArray<AwsRegion>, AwsSecurityReadError> => {
	const call = callAs({ httpClient, session, region: Schema.decodeSync(AwsRegion)("us-east-1") })
	return Effect.gen(function* () {
		const names = yield* Ref.make<ReadonlyArray<string>>([])
		yield* pagesOf(
			(token) =>
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
			(regions) =>
				Ref.update(names, (seen) =>
					Arr.appendAll(
						seen,
						Arr.getSomes(Arr.map(regions, (region) => Option.fromUndefinedOr(region.RegionName))),
					),
				),
			MAX_PAGES,
			Number.POSITIVE_INFINITY,
		)
		const all = yield* Ref.get(names)
		return Arr.filter(all, isRegion)
	})
}

// CloudTrail

/**
 * CloudTrail lists an event up to about 15 minutes after it happened: a read stops this far short of
 * now and the next one starts where it stopped, so every event is read once, after it has arrived.
 */
export const CLOUDTRAIL_LATE_MS = 15 * MINUTE_MS
/** How far back the first read of a region goes. */
export const CLOUDTRAIL_BACKFILL_MS = 60 * MINUTE_MS
/** A region whose cursor fell further behind than this restarts here, and says what it skipped. */
const CLOUDTRAIL_MAX_BEHIND_MS = DAY_MS
/** Each read starts this far behind the cursor, for an event CloudTrail listed after the margin. */
export const CLOUDTRAIL_OVERLAP_MS = 3 * MINUTE_MS
/** Pages one CloudTrail read takes per poll: LookupEvents allows about 2 a second per region. */
export const CLOUDTRAIL_PAGES = 40

export interface CloudTrailRead {
	readonly state: CloudServiceState
	readonly events: number
	readonly cursorAt: number | null
	readonly windowMs: number | null
	readonly lastError: string | null
}

/**
 * The region's write management events from the cursor to the late margin, in time windows oldest
 * first. An event read again (a split window) lands on the same audit trail key.
 */
export const readCloudTrail = <E>(
	target: ReadTarget,
	sink: Sink<AuditTrailEvent, E>,
): Effect.Effect<CloudTrailRead, E> => {
	const endMs = target.nowMs - CLOUDTRAIL_LATE_MS
	const oldestKept = endMs - CLOUDTRAIL_MAX_BEHIND_MS
	const dropped = target.cursorAt !== null && target.cursorAt < oldestKept
	const startMs =
		target.cursorAt === null ? endMs - CLOUDTRAIL_BACKFILL_MS : Num.max(oldestKept, target.cursorAt)
	// LookupEvents answers newest first: the oldest event read sizes a split window.
	const lookupWindow = (
		fromMs: number,
		toMs: number,
		maxPages: number,
	): Effect.Effect<PagesRead, AwsSecurityReadError | E> =>
		Effect.gen(function* () {
			// LookupEvents answers newest first: the oldest event read sizes a split window.
			const oldest = yield* Ref.make<number | undefined>(undefined)
			const read = yield* pagesOf(
				(token) =>
					Effect.map(
						callAs(target)(
							"CloudTrail.LookupEvents",
							CloudTrail.lookupEvents({
								region: target.region,
								LookupAttributes: [{ AttributeKey: "ReadOnly", AttributeValue: "false" }],
								StartTime: dateOf(fromMs),
								EndTime: dateOf(toMs),
								MaxResults: 50,
								NextToken: token,
							}),
						),
						(page) => ({
							items: Arr.getSomes(
								Arr.map(page.Events ?? [], (event) =>
									cloudTrailAuditEvent(target.accountId, event),
								),
							),
							next: page.NextToken,
						}),
					),
				(events) =>
					Effect.andThen(
						Ref.update(oldest, (current) =>
							Arr.reduce(events, current, (min: number | undefined, event) =>
								min === undefined ? event.occurredAtMs : Num.min(min, event.occurredAtMs),
							),
						),
						sink(events),
					),
				maxPages,
				target.deadlineMs,
			)
			const oldestMs = yield* Ref.get(oldest)
			return oldestMs === undefined ? read : { ...read, oldestMs }
		})
	return Effect.gen(function* () {
		// The few minutes behind the cursor, for events CloudTrail listed late: one capped window of
		// their own, so a burst there can neither stall the read nor regrow its span.
		// Not while the cursor sits on a dense second: that second gets every page of this poll.
		const onDenseSecond = target.windowMs !== null && target.windowMs <= MIN_WINDOW_MS
		const overlapFrom =
			target.cursorAt === null || onDenseSecond
				? startMs
				: Num.max(oldestKept, startMs - CLOUDTRAIL_OVERLAP_MS)
		const overlap =
			overlapFrom < startMs
				? yield* lookupWindow(overlapFrom, startMs, WINDOW_PAGES)
				: { count: 0, pages: 0, complete: true }
		const read = yield* readWindows(
			{
				startMs,
				endMs,
				spanMs: target.windowMs ?? 15 * MINUTE_MS,
				maxSpanMs: CLOUDTRAIL_MAX_BEHIND_MS,
				budgetPages: CLOUDTRAIL_PAGES - overlap.pages,
				deadlineMs: target.deadlineMs,
			},
			lookupWindow,
		)
		return { ...read, count: read.count + overlap.count }
	}).pipe(
		Effect.map((read): CloudTrailRead => ({
			state: "enabled",
			events: read.count,
			cursorAt: read.cursorAt,
			windowMs: read.spanMs,
			lastError: dropped
				? "This region fell more than a day behind; changes older than a day were skipped."
				: windowsError(read, "changes"),
		})),
		Effect.catchIf(isReadError, (error) =>
			Effect.succeed({
				state: error.kind,
				events: 0,
				cursorAt: null,
				windowMs: null,
				lastError: error.message,
			} satisfies CloudTrailRead),
		),
		Effect.withSpan("AwsSecurity.readCloudTrail", {
			attributes: { "maple.aws.region": target.region },
		}),
	)
}
