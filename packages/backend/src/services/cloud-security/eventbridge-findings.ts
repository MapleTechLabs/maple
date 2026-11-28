import {
	type AwsFindingSource,
	cloudFindingSeverityOfLabel,
	cloudFindingSeverityOfScore,
} from "@maple/domain/cloud-security"
import { AwsRegion } from "@maple/primitives"
import { Array as Arr, Option, Predicate, Schema } from "effect"
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

// A finding event EventBridge delivered from the customer's account, in the shape the poller
// stores. Each service sends its finding in its own API's casing; only this account's are kept.

type Json = Readonly<Record<string, unknown>>

const isJson = (value: unknown): value is Json => Predicate.isObject(value) && !Arr.isArray(value)
const objectAt = (value: Json | undefined, key: string): Json | undefined => {
	const found = value?.[key]
	return isJson(found) ? found : undefined
}
const textAt = (value: Json | undefined, key: string): string | undefined => {
	const found = value?.[key]
	return typeof found === "string" && found !== "" ? found : undefined
}
const numberAt = (value: Json | undefined, key: string): number | undefined => {
	const found = value?.[key]
	return typeof found === "number" && Number.isFinite(found) ? found : undefined
}
const isTrueAt = (value: Json | undefined, key: string): boolean => value?.[key] === true

const objectsAt = (value: Json | undefined, key: string): ReadonlyArray<Json> => {
	const found = value?.[key]
	return Arr.isArray(found) ? Arr.filter(found, isJson) : []
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
// Newer formatters put a narrow no-break space before AM/PM.
const INSPECTOR_TIME = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})[ \u202f](AM|PM)$/u

/** Inspector's events write times as `Mar 31, 2022, 10:51:08 PM` (UTC); its API writes ISO. */
const inspectorTime = (value: string | undefined): number | undefined => {
	if (value === undefined) return undefined
	const match = INSPECTOR_TIME.exec(value)
	if (match === null) return msOf(value)
	const [, month, day, year, hour, minute, second, half] = match
	const monthIndex = MONTHS.indexOf(month ?? "")
	if (monthIndex < 0) return undefined
	const hour12 = Number(hour) % 12
	return Date.UTC(
		Number(year),
		monthIndex,
		Number(day),
		half === "PM" ? hour12 + 12 : hour12,
		Number(minute),
		Number(second),
	)
}

/** The resource a GuardDuty finding is about: the first detail block that names one, as the poller reads it. */
const guardDutyResource = (
	resource: Json | undefined,
): { readonly resourceId: string | undefined; readonly resourceName: string | undefined } => {
	const block = (key: string) => objectAt(resource, key)
	const bucket = objectsAt(resource, "s3BucketDetails")[0]
	const candidates: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
		[textAt(block("instanceDetails"), "instanceId"), undefined],
		[textAt(block("accessKeyDetails"), "accessKeyId"), textAt(block("accessKeyDetails"), "userName")],
		[textAt(block("eksClusterDetails"), "name"), undefined],
		[textAt(block("lambdaDetails"), "functionName"), undefined],
		[textAt(block("ecsClusterDetails"), "name"), undefined],
		[textAt(block("rdsDbInstanceDetails"), "dbInstanceIdentifier"), undefined],
		[textAt(bucket, "name"), undefined],
		[textAt(block("containerDetails"), "id"), textAt(block("containerDetails"), "name")],
	]
	const [resourceId, resourceName] = Option.getOrElse(
		Arr.findFirst(candidates, ([id]) => id !== undefined),
		() => [undefined, undefined] as const,
	)
	return { resourceId, resourceName }
}

/** GuardDuty sends the finding as `GetFindings` returns it, in camelCase. */
const guardDutyFinding = (detail: Json, nowMs: number): Option.Option<FindingRead> => {
	const id = textAt(detail, "id")
	const type = textAt(detail, "type")
	if (id === undefined || type === undefined) return Option.none()
	const service = objectAt(detail, "service")
	const resource = objectAt(detail, "resource")
	return readFinding(
		{
			findingId: id,
			type,
			title: textAt(detail, "title"),
			description: textAt(detail, "description"),
			severity: cloudFindingSeverityOfScore(numberAt(detail, "severity") ?? 0),
			status: service?.["archived"] === true ? "archived" : "active",
			resourceType: textAt(resource, "resourceType"),
			...guardDutyResource(resource),
			occurrences: numberAt(service, "count"),
			firstSeenAt: msOf(textAt(service, "eventFirstSeen") ?? textAt(detail, "createdAt")),
			lastSeenAt: msOf(textAt(service, "eventLastSeen") ?? textAt(detail, "updatedAt")),
			updatedAt: msOf(textAt(detail, "updatedAt")),
			detail: { arn: textAt(detail, "arn"), resource, action: service?.["action"] },
		},
		nowMs,
	)
}

/** Security Hub sends findings in ASFF, which is PascalCase on the wire too. */
const securityHubFinding = (finding: Json, nowMs: number): Option.Option<FindingRead> => {
	const id = textAt(finding, "Id")
	if (id === undefined) return Option.none()
	const resources = objectsAt(finding, "Resources")
	const resource = resources[0]
	const types = finding["Types"]
	const firstType = Arr.isArray(types) && typeof types[0] === "string" ? types[0] : undefined
	return readFinding(
		{
			findingId: id,
			type: textAt(finding, "GeneratorId") ?? firstType ?? "Finding",
			title: textAt(finding, "Title"),
			description: textAt(finding, "Description"),
			severity: cloudFindingSeverityOfLabel(textAt(objectAt(finding, "Severity"), "Label")),
			status: securityHubStatus({
				recordState: textAt(finding, "RecordState"),
				complianceStatus: textAt(objectAt(finding, "Compliance"), "Status"),
				workflowStatus: textAt(objectAt(finding, "Workflow"), "Status"),
			}),
			resourceType: textAt(resource, "Type"),
			resourceId: textAt(resource, "Id"),
			resourceName: undefined,
			occurrences: undefined,
			firstSeenAt: msOf(textAt(finding, "FirstObservedAt") ?? textAt(finding, "CreatedAt")),
			lastSeenAt: msOf(textAt(finding, "LastObservedAt") ?? textAt(finding, "UpdatedAt")),
			updatedAt: msOf(textAt(finding, "UpdatedAt")),
			detail: {
				productName: textAt(finding, "ProductName"),
				compliance: finding["Compliance"],
				remediation: finding["Remediation"],
				resources,
			},
		},
		nowMs,
	)
}

/** Inspector sends the finding as `ListFindings` returns it, with its own time format. */
const inspectorFinding = (detail: Json, nowMs: number): Option.Option<FindingRead> => {
	const arn = textAt(detail, "findingArn")
	if (arn === undefined) return Option.none()
	const resource = objectsAt(detail, "resources")[0]
	const vulnerability = objectAt(detail, "packageVulnerabilityDetails")
	return readFinding(
		{
			findingId: arn,
			type: textAt(vulnerability, "vulnerabilityId") ?? textAt(detail, "type") ?? "Finding",
			title: textAt(detail, "title"),
			description: textAt(detail, "description"),
			severity: cloudFindingSeverityOfLabel(textAt(detail, "severity")),
			status: inspectorStatus(textAt(detail, "status")),
			resourceType: textAt(resource, "type"),
			resourceId: textAt(resource, "id"),
			resourceName: undefined,
			occurrences: undefined,
			firstSeenAt: inspectorTime(textAt(detail, "firstObservedAt")),
			lastSeenAt: inspectorTime(textAt(detail, "lastObservedAt")),
			updatedAt: inspectorTime(textAt(detail, "updatedAt") ?? textAt(detail, "lastObservedAt")),
			detail: {
				findingType: textAt(detail, "type"),
				inspectorScore: numberAt(detail, "inspectorScore"),
				fixAvailable: textAt(detail, "fixAvailable"),
				exploitAvailable: textAt(detail, "exploitAvailable"),
				remediation: detail["remediation"],
				packageVulnerabilityDetails: vulnerability,
			},
		},
		nowMs,
	)
}

/** Access Analyzer names an external access finding `id`, an unused access one `findingId`. */
const accessAnalyzerFinding = (
	detail: Json,
	unusedAccess: boolean,
	nowMs: number,
): Option.Option<FindingRead> => {
	const id = textAt(detail, "id") ?? textAt(detail, "findingId")
	if (id === undefined) return Option.none()
	const findingType =
		textAt(detail, "findingType") ?? (unusedAccess ? "UnusedPermission" : "ExternalAccess")
	return readFinding(
		{
			findingId: id,
			type: findingType,
			title: accessAnalyzerTitle(findingType),
			description: textAt(detail, "error"),
			severity: accessAnalyzerSeverity(findingType),
			// A deleted finding keeps its last status and says so with `isDeleted`.
			status: isTrueAt(detail, "isDeleted")
				? "resolved"
				: accessAnalyzerStatus(textAt(detail, "status")),
			resourceType: textAt(detail, "resourceType"),
			resourceId: textAt(detail, "resource"),
			resourceName: undefined,
			occurrences: undefined,
			firstSeenAt: msOf(textAt(detail, "createdAt")),
			lastSeenAt: msOf(textAt(detail, "analyzedAt") ?? textAt(detail, "updatedAt")),
			updatedAt: msOf(textAt(detail, "updatedAt")),
			detail: { resourceOwnerAccount: textAt(detail, "resourceOwnerAccount") },
		},
		nowMs,
	)
}

/** The finding events the setup's rule forwards, by `source` and `detail-type`. */
export const FINDING_EVENT_PATTERN = {
	"aws.guardduty": ["GuardDuty Finding"],
	"aws.securityhub": ["Security Hub Findings - Imported"],
	"aws.inspector2": ["Inspector2 Finding"],
	"aws.access-analyzer": ["Access Analyzer Finding", "Unused Access Finding for IAM entities"],
} as const

/** Findings taken from one event. Security Hub sends a handful at most; the rest are left to the poller. */
export const MAX_FINDINGS_PER_EVENT = 100

/** What one event says, for one service in one region of one account. */
export interface FindingEvent {
	readonly source: AwsFindingSource
	readonly region: AwsRegion
	readonly findings: ReadonlyArray<FindingRead>
	/** Findings left out: another account's, or with no id or time. */
	readonly skipped: number
	/** Findings past `MAX_FINDINGS_PER_EVENT`, not read at all. */
	readonly overCap: number
}

const decodeRegion = Schema.decodeUnknownOption(AwsRegion)

/**
 * An EventBridge event as the findings it carries for `accountId`, none dated after `nowMs`. None
 * for an event that is not a finding event the setup forwards. An administrator account's events
 * also carry its members' findings, and Security Hub's carry the other services' copies: both are
 * skipped, as the poller does.
 */
export const findingEvent = (
	accountId: string,
	event: unknown,
	nowMs: number,
): Option.Option<FindingEvent> => {
	if (!isJson(event)) return Option.none()
	const source = textAt(event, "source")
	const detailType = textAt(event, "detail-type")
	const detail = objectAt(event, "detail")
	const region = decodeRegion(textAt(event, "region"))
	if (detail === undefined || Option.isNone(region)) return Option.none()
	// Every service names the finding's account; one that did not is the event's own account, which
	// EventBridge always sets. A finding that names neither is not known to be this account's.
	const eventAccount = textAt(event, "account")
	const ours = (account: string | undefined) => (account ?? eventAccount) === accountId
	const of = (
		findingSource: AwsFindingSource,
		candidates: ReadonlyArray<Json>,
		accountOf: (candidate: Json) => string | undefined,
		read: (candidate: Json) => Option.Option<FindingRead>,
	): Option.Option<FindingEvent> => {
		const taken = Arr.take(candidates, MAX_FINDINGS_PER_EVENT)
		const kept = Arr.getSomes(
			Arr.map(
				Arr.filter(taken, (candidate) => ours(accountOf(candidate))),
				read,
			),
		)
		return Option.some({
			source: findingSource,
			region: region.value,
			findings: kept,
			skipped: taken.length - kept.length,
			overCap: candidates.length - taken.length,
		})
	}
	switch (source) {
		case "aws.guardduty":
			return detailType === "GuardDuty Finding"
				? of(
						"guardduty",
						[detail],
						(finding) => textAt(finding, "accountId"),
						(finding) => guardDutyFinding(finding, nowMs),
					)
				: Option.none()
		case "aws.securityhub": {
			if (detailType !== "Security Hub Findings - Imported") return Option.none()
			const all = objectsAt(detail, "findings")
			const taken = Arr.take(all, MAX_FINDINGS_PER_EVENT)
			const findings = Arr.filter(taken, (finding) => {
				const product = textAt(finding, "ProductName")
				const findingRegion = textAt(finding, "Region")
				// An aggregation region forwards the linked regions' findings: each region reads its own.
				return (
					(product === undefined || !AGGREGATED_PRODUCTS.includes(product)) &&
					(findingRegion === undefined || findingRegion === region.value)
				)
			})
			return Option.map(
				of(
					"securityhub",
					findings,
					(finding) => textAt(finding, "AwsAccountId"),
					(finding) => securityHubFinding(finding, nowMs),
				),
				(read) => ({
					...read,
					skipped: read.skipped + (taken.length - findings.length),
					overCap: all.length - taken.length,
				}),
			)
		}
		case "aws.inspector2":
			return detailType === "Inspector2 Finding"
				? of(
						"inspector",
						[detail],
						(finding) => textAt(finding, "awsAccountId"),
						(finding) => inspectorFinding(finding, nowMs),
					)
				: Option.none()
		case "aws.access-analyzer": {
			const unusedAccess = detailType === "Unused Access Finding for IAM entities"
			if (detailType !== "Access Analyzer Finding" && !unusedAccess) return Option.none()
			return of(
				"access_analyzer",
				[detail],
				(finding) => textAt(finding, "resourceOwnerAccount") ?? textAt(finding, "accountId"),
				(finding) => accessAnalyzerFinding(finding, unusedAccess, nowMs),
			)
		}
		default:
			return Option.none()
	}
}
