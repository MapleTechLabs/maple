/**
 * GuardDuty, Security Hub, Inspector, IAM Access Analyzer and the Account API, as far as the findings
 * poller calls them, in front of a fallback (the fake STS). Findings are held in each service's wire
 * shape; listings filter, sort and page the way the services do for the inputs the poller sends.
 */
import {
	Array as Arr,
	DateTime,
	Effect,
	Option,
	Order,
	Predicate,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

type Json = Record<string, unknown>

export interface FakeGuardDutyFinding {
	readonly id: string
	readonly type: string
	readonly title: string
	readonly severity: number
	readonly updatedAtMs: number
	readonly archived?: boolean
	readonly count?: number
	readonly instanceId?: string
	readonly accountId?: string
}

export interface FakeSecurityHubFinding {
	readonly id: string
	readonly productName: string
	readonly generatorId: string
	readonly title: string
	readonly label: string
	readonly updatedAtMs: number
	readonly recordState?: "ACTIVE" | "ARCHIVED"
	readonly compliance?: "PASSED" | "FAILED"
	/** Set in the console: Security Hub does not move `UpdatedAt` for it. */
	readonly workflow?: "NEW" | "SUPPRESSED" | "RESOLVED"
	readonly resourceId?: string
	/** A member account's finding, as an administrator account lists it. */
	readonly accountId?: string
	/** A linked region's finding, as an aggregation region lists it. */
	readonly region?: string
}

export interface FakeInspectorFinding {
	readonly arn: string
	readonly title: string
	readonly severity: string
	readonly status: "ACTIVE" | "SUPPRESSED" | "CLOSED"
	readonly updatedAtMs: number
	readonly cve?: string
	readonly resourceId?: string
	readonly accountId?: string
}

export interface FakeAccessAnalyzerFinding {
	readonly id: string
	readonly findingType: string
	readonly status: "ACTIVE" | "ARCHIVED" | "RESOLVED"
	readonly resource: string
	readonly updatedAtMs: number
}

/** A CloudTrail record; `record` is the event's JSON body, `eventTimeMs` when it happened. */
export interface FakeCloudTrailEvent {
	readonly eventId: string
	readonly eventTimeMs: number
	readonly record: Record<string, unknown>
	readonly readOnly?: boolean
}

/** One region's services; an absent service is not enabled there. */
export interface FakeRegion {
	guardduty?: Array<FakeGuardDutyFinding>
	securityhub?: Array<FakeSecurityHubFinding>
	inspector?: Array<FakeInspectorFinding>
	accessAnalyzer?: Array<FakeAccessAnalyzerFinding>
	/** The account analyzer's status; ACTIVE when absent. */
	analyzerStatus?: "ACTIVE" | "CREATING" | "FAILED"
	cloudtrail?: Array<FakeCloudTrailEvent>
}

export interface FakeAwsSecurityRequest {
	readonly service: string
	readonly region: string
	readonly method: string
	readonly path: string
	readonly body: Json
}

export interface FakeAwsSecurity {
	readonly client: HttpClient.HttpClient
	readonly regions: Record<string, FakeRegion>
	/** Services (`guardduty`, `securityhub`, `inspector2`, `access-analyzer`, `account`) that answer AccessDenied. */
	readonly denied: Set<string>
	readonly requests: Array<FakeAwsSecurityRequest>
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decoder = new TextDecoder()
const HOST =
	/^https:\/\/(guardduty|securityhub|inspector2|access-analyzer|account|cloudtrail)\.([a-z0-9-]+)\.amazonaws\.com(\/[^?]*)/u

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))
const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined)
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)
const asRecord = (value: unknown): Json | undefined =>
	Predicate.isObject(value) && !Arr.isArray(value) ? value : undefined
const asArray = (value: unknown): ReadonlyArray<unknown> => (Arr.isArray(value) ? value : [])
const msOfIso = (value: string) =>
	Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.toEpochMillis))

/** A page of `items` from the offset `token` names. */
const pageOf = <A>(items: ReadonlyArray<A>, token: unknown, size: number) => {
	const start = Number(asString(token) ?? "0")
	const end = start + size
	return { items: items.slice(start, end), next: end < items.length ? String(end) : undefined }
}

const OWN_ACCOUNT = "111111111111"

/** The `Value`s of a Security Hub string filter with this comparison. */
const valuesOf = (filter: unknown, comparison: string) =>
	Arr.getSomes(
		Arr.map(
			Arr.filter(asArray(filter), (entry) => asRecord(entry)?.["Comparison"] === comparison),
			(entry) => Option.fromUndefinedOr(asString(asRecord(entry)?.["Value"])),
		),
	)

const byUpdated = <A extends { readonly updatedAtMs: number }>(items: ReadonlyArray<A>) =>
	Arr.sort(
		items,
		Order.mapInput(Order.Number, (item: A) => item.updatedAtMs),
	)

export const makeFakeAwsSecurity = (fallback: HttpClient.HttpClient): FakeAwsSecurity => {
	const state: FakeAwsSecurity = {
		regions: {},
		denied: new Set(),
		requests: [],
		client: HttpClient.make((request) => {
			const match = HOST.exec(request.url)
			if (match === null) return fallback.execute(request)
			const [, service = "", region = "", path = ""] = match
			const json = (status: number, body: unknown, errorType?: string) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response(encodeJson(body), {
							status,
							headers:
								errorType === undefined
									? { "content-type": "application/json" }
									: { "content-type": "application/json", "x-amzn-errortype": errorType },
						}),
					),
				)
			const refuse = (status: number, type: string) => json(status, { message: `fake ${type}` }, type)
			// Signed with a session, for this service, in this region.
			const scope = new RegExp(`Credential=ASIA[^/]*/\\d{8}/${region}/${service}/aws4_request`, "u")
			if (
				!scope.test(request.headers["authorization"] ?? "") ||
				request.headers["x-amz-security-token"] === undefined
			) {
				return refuse(403, "UnrecognizedClientException")
			}
			const body = Option.getOrElse(
				decodeJson(request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "{}"),
				(): Json => ({}),
			)
			state.requests.push({ service, region, method: request.method, path, body })
			if (state.denied.has(service)) return refuse(403, "AccessDeniedException")
			const fake = state.regions[region] ?? {}
			const route = `${service} ${request.method} ${path}`

			if (route === "account POST /listRegions") {
				return json(200, {
					Regions: Arr.map(Rec.keys(state.regions), (name) => ({
						RegionName: name,
						RegionOptStatus: "ENABLED",
					})),
				})
			}
			if (route === "guardduty GET /detector") {
				return json(200, { detectorIds: fake.guardduty === undefined ? [] : [`det-${region}`] })
			}
			if (service === "guardduty" && Str.endsWith("/findings")(path)) {
				const criterion = asRecord(asRecord(body["findingCriteria"])?.["criterion"]) ?? {}
				const since = asNumber(asRecord(criterion["updatedAt"])?.["greaterThanOrEqual"])
				const openOnly = criterion["service.archived"] !== undefined
				const accounts = asArray(asRecord(criterion["accountId"])?.["equals"])
				const matching = Arr.filter(
					byUpdated(fake.guardduty ?? []),
					(finding) =>
						(accounts.length === 0 || accounts.includes(finding.accountId ?? OWN_ACCOUNT)) &&
						(since === undefined || finding.updatedAtMs >= since) &&
						(!openOnly || finding.archived !== true),
				)
				const page = pageOf(matching, body["nextToken"], asNumber(body["maxResults"]) ?? 50)
				return json(200, {
					findingIds: Arr.map(page.items, (finding) => finding.id),
					nextToken: page.next,
				})
			}
			if (service === "guardduty" && Str.endsWith("/findings/get")(path)) {
				const ids = asArray(body["findingIds"])
				return json(200, {
					findings: Arr.map(
						Arr.filter(fake.guardduty ?? [], (finding) => ids.includes(finding.id)),
						(finding) => ({
							accountId: finding.accountId ?? OWN_ACCOUNT,
							arn: `arn:aws:guardduty:${region}:111111111111:detector/det/finding/${finding.id}`,
							createdAt: iso(finding.updatedAtMs - 1000),
							id: finding.id,
							region,
							schemaVersion: "2.0",
							severity: finding.severity,
							title: finding.title,
							type: finding.type,
							updatedAt: iso(finding.updatedAtMs),
							resource: {
								resourceType: finding.instanceId === undefined ? "AccessKey" : "Instance",
								instanceDetails:
									finding.instanceId === undefined
										? undefined
										: { instanceId: finding.instanceId },
							},
							service: {
								archived: finding.archived === true,
								count: finding.count ?? 1,
								eventFirstSeen: iso(finding.updatedAtMs - 1000),
								eventLastSeen: iso(finding.updatedAtMs),
								serviceName: "guardduty",
							},
						}),
					),
				})
			}
			if (route === "securityhub GET /accounts") {
				return fake.securityhub === undefined
					? refuse(401, "InvalidAccessException")
					: json(200, { HubArn: `arn:aws:securityhub:${region}:111111111111:hub/default` })
			}
			if (route === "securityhub POST /findings") {
				const filters = asRecord(body["Filters"]) ?? {}
				const excluded = valuesOf(filters["ProductName"], "NOT_EQUALS")
				const ids = valuesOf(filters["Id"], "EQUALS")
				const accounts = valuesOf(filters["AwsAccountId"], "EQUALS")
				const regions = valuesOf(filters["Region"], "EQUALS")
				const notCompliance = valuesOf(filters["ComplianceStatus"], "NOT_EQUALS")
				const range = asRecord(Option.getOrUndefined(Arr.head(asArray(filters["UpdatedAt"]))))
				const start = asString(range?.["Start"])
				const end = asString(range?.["End"])
				// Security Hub refuses an UpdatedAt filter with only one end.
				if ((start === undefined) !== (end === undefined)) return refuse(400, "InvalidInputException")
				const activeOnly = filters["RecordState"] !== undefined
				const matching = Arr.filter(
					byUpdated(fake.securityhub ?? []),
					(finding) =>
						!excluded.includes(finding.productName) &&
						(ids.length === 0 || ids.includes(finding.id)) &&
						(accounts.length === 0 || accounts.includes(finding.accountId ?? OWN_ACCOUNT)) &&
						(regions.length === 0 || regions.includes(finding.region ?? region)) &&
						!notCompliance.includes(finding.compliance ?? "") &&
						(start === undefined || finding.updatedAtMs >= (msOfIso(start) ?? 0)) &&
						(end === undefined || finding.updatedAtMs <= (msOfIso(end) ?? 0)) &&
						(!activeOnly || finding.recordState !== "ARCHIVED"),
				)
				const page = pageOf(matching, body["NextToken"], asNumber(body["MaxResults"]) ?? 100)
				return json(200, {
					Findings: Arr.map(page.items, (finding) => ({
						SchemaVersion: "2018-10-08",
						Id: finding.id,
						ProductArn: `arn:aws:securityhub:${region}::product/aws/securityhub`,
						ProductName: finding.productName,
						GeneratorId: finding.generatorId,
						AwsAccountId: finding.accountId ?? OWN_ACCOUNT,
						Region: finding.region ?? region,
						CreatedAt: iso(finding.updatedAtMs - 1000),
						UpdatedAt: iso(finding.updatedAtMs),
						Title: finding.title,
						Description: `${finding.title}.`,
						Severity: { Label: finding.label },
						Resources: [{ Type: "AwsS3Bucket", Id: finding.resourceId ?? "arn:aws:s3:::bucket" }],
						RecordState: finding.recordState ?? "ACTIVE",
						Compliance:
							finding.compliance === undefined ? undefined : { Status: finding.compliance },
						Workflow: { Status: finding.workflow ?? "NEW" },
					})),
					NextToken: page.next,
				})
			}
			if (route === "inspector2 POST /status/batch/get") {
				return json(200, {
					accounts: [
						{
							accountId: "111111111111",
							state: { status: fake.inspector === undefined ? "DISABLED" : "ENABLED" },
							resourceState: {
								ec2: { status: "ENABLED" },
								ecr: { status: "ENABLED" },
							},
						},
					],
				})
			}
			if (route === "inspector2 POST /findings/list") {
				const criteria = asRecord(body["filterCriteria"]) ?? {}
				const range = asRecord(Option.getOrUndefined(Arr.head(asArray(criteria["updatedAt"]))))
				const since = asNumber(range?.["startInclusive"])
				const until = asNumber(range?.["endInclusive"])
				const account = asString(
					asRecord(Option.getOrUndefined(Arr.head(asArray(criteria["awsAccountId"]))))?.["value"],
				)
				const arns = Arr.getSomes(
					Arr.map(asArray(criteria["findingArn"]), (filter) =>
						Option.fromUndefinedOr(asString(asRecord(filter)?.["value"])),
					),
				)
				const matching = Arr.filter(
					fake.inspector ?? [],
					(finding) =>
						(since === undefined || finding.updatedAtMs / 1000 >= since) &&
						(until === undefined || finding.updatedAtMs / 1000 <= until) &&
						(account === undefined || account === (finding.accountId ?? OWN_ACCOUNT)) &&
						(arns.length === 0 || arns.includes(finding.arn)),
				)
				const page = pageOf(matching, body["nextToken"], asNumber(body["maxResults"]) ?? 100)
				return json(200, {
					findings: Arr.map(page.items, (finding) => ({
						findingArn: finding.arn,
						awsAccountId: finding.accountId ?? OWN_ACCOUNT,
						type: "PACKAGE_VULNERABILITY",
						description: `${finding.title}.`,
						title: finding.title,
						remediation: {},
						severity: finding.severity,
						firstObservedAt: (finding.updatedAtMs - 1000) / 1000,
						lastObservedAt: finding.updatedAtMs / 1000,
						updatedAt: finding.updatedAtMs / 1000,
						status: finding.status,
						resources: [{ type: "AWS_EC2_INSTANCE", id: finding.resourceId ?? "i-0inspected" }],
						packageVulnerabilityDetails:
							finding.cve === undefined
								? undefined
								: { vulnerabilityId: finding.cve, source: "NVD" },
					})),
					nextToken: page.next,
				})
			}
			if (route === "access-analyzer GET /analyzer") {
				return json(200, {
					analyzers:
						fake.accessAnalyzer === undefined
							? []
							: [
									{
										arn: `arn:aws:access-analyzer:${region}:111111111111:analyzer/account`,
										name: "account",
										type: "ACCOUNT",
										createdAt: iso(0),
										status: fake.analyzerStatus ?? "ACTIVE",
									},
								],
				})
			}
			if (route === "access-analyzer POST /findingv2") {
				const statuses = asArray(asRecord(asRecord(body["filter"])?.["status"])?.["eq"])
				const page = pageOf(
					Arr.filter(
						fake.accessAnalyzer ?? [],
						(finding) => statuses.length === 0 || statuses.includes(finding.status),
					),
					body["nextToken"],
					asNumber(body["maxResults"]) ?? 100,
				)
				return json(200, {
					findings: Arr.map(page.items, (finding) => ({
						id: finding.id,
						findingType: finding.findingType,
						status: finding.status,
						resource: finding.resource,
						resourceType: "AWS::S3::Bucket",
						resourceOwnerAccount: "111111111111",
						createdAt: iso(finding.updatedAtMs - 1000),
						analyzedAt: iso(finding.updatedAtMs),
						updatedAt: iso(finding.updatedAtMs),
					})),
					nextToken: page.next,
				})
			}
			if (route === "cloudtrail POST /") {
				// JSON 1.1: times are epoch seconds, events come newest first.
				const writesOnly = Arr.some(
					asArray(body["LookupAttributes"]),
					(attribute) =>
						asRecord(attribute)?.["AttributeKey"] === "ReadOnly" &&
						asRecord(attribute)?.["AttributeValue"] === "false",
				)
				const start = (asNumber(body["StartTime"]) ?? 0) * 1000
				const end = (asNumber(body["EndTime"]) ?? Number.MAX_SAFE_INTEGER / 1000) * 1000
				const matching = Arr.reverse(
					Arr.sort(
						Arr.filter(
							fake.cloudtrail ?? [],
							(event) =>
								event.eventTimeMs >= start &&
								event.eventTimeMs <= end &&
								(!writesOnly || event.readOnly !== true),
						),
						Order.mapInput(Order.Number, (event: FakeCloudTrailEvent) => event.eventTimeMs),
					),
				)
				const page = pageOf(matching, body["NextToken"], asNumber(body["MaxResults"]) ?? 50)
				return json(200, {
					Events: Arr.map(page.items, (event) => ({
						EventId: event.eventId,
						EventTime: event.eventTimeMs / 1000,
						ReadOnly: event.readOnly === true ? "true" : "false",
						CloudTrailEvent: encodeJson(event.record),
					})),
					NextToken: page.next,
				})
			}
			return refuse(404, `UnknownOperation ${route}`)
		}),
	}
	return state
}
