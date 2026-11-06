/**
 * The small, consistent world the tool tasks run in.
 *
 * An empty warehouse makes tasks unfair: the production prompt has the agent check what exists
 * first, and in an empty org it finds nothing and spends its calls hunting for data instead of
 * answering. So the services, attributes and errors the tasks name exist here, and the probes an
 * agent opens with (list_services, ingest_freshness, explore_attributes, find_errors) answer with
 * them. Timestamps are relative to now, so freshness reads healthy on every run.
 *
 * Rows are routed by the shape of the compiled SQL, the same way `fake-warehouse.ts` routes the
 * trace fixtures. Anything not modeled here gets no rows.
 */
import { executeSql } from "@maple/backend/platform/test-pglite"
import type { EvalRuntime } from "../mcp/__evals__/eval-runtime"
import type { FixtureRule } from "../mcp/__evals__/fake-warehouse"
import { FIXTURES } from "../mcp/__evals__/utils"
import { Array as Arr, Option, String as Str } from "effect"

interface WorldService {
	readonly name: string
	readonly throughput: number
	readonly errors: number
	readonly p50: number
	readonly p95: number
	readonly p99: number
	readonly operations: ReadonlyArray<readonly [name: string, count: number]>
}

export const WORLD_SERVICES: ReadonlyArray<WorldService> = [
	{
		name: FIXTURES.service,
		throughput: 182_400,
		errors: 912,
		p50: 18,
		p95: 140,
		p99: 610,
		operations: [
			["GET /api/checkout", 61_200],
			["POST /api/orders", 40_100],
			["db.query users", 38_000],
			["GET /api/health", 21_000],
		],
	},
	{
		name: "subscriptions-api",
		throughput: 96_300,
		errors: 2_410,
		p50: 35,
		p95: 420,
		p99: 1_900,
		operations: [
			["PublicApiKeyAuthn", 30_200],
			["AuthnV2Live.bearer", 28_400],
			["sql.execute", 22_100],
			["POST /v2/subscriptions", 9_800],
		],
	},
	{
		name: "consumer-stripe-v2",
		throughput: 41_700,
		errors: 310,
		p50: 60,
		p95: 800,
		p99: 2_400,
		operations: [
			["processStripeV2", 18_900],
			["Stripe.charges.create", 12_300],
			["sql.execute", 7_400],
		],
	},
	{
		name: "consumer-app-store-connect",
		throughput: 12_100,
		errors: 640,
		p50: 120,
		p95: 1_500,
		p99: 4_800,
		operations: [["AppStore.verifyReceipt", 9_000]],
	},
	{
		name: "consumer-google-play-to-or",
		throughput: 9_800,
		errors: 120,
		p50: 95,
		p95: 900,
		p99: 3_100,
		operations: [["GooglePlay.acknowledge", 7_100]],
	},
	{
		name: "checkout",
		throughput: 54_000,
		errors: 1_020,
		p50: 70,
		p95: 950,
		p99: 3_600,
		operations: [
			["POST /checkout", 31_000],
			["inventory.reserve", 23_000],
		],
	},
]

const ATTRIBUTE_VALUES = new Map<string, ReadonlyArray<readonly [string, number]>>([
	[
		"applicationId",
		[
			["16408", 5_120],
			["22011", 2_300],
		],
	],
	[
		"deviceId",
		[
			["ios-7f3a91", 820],
			["android-1c22e0", 640],
		],
	],
	[
		"http.response.status_code",
		[
			["200", 310_000],
			["500", 3_900],
			["404", 1_200],
		],
	],
	[
		"http.route",
		[
			["/api/checkout", 61_200],
			["/v2/subscriptions", 9_800],
		],
	],
	[
		"user.id",
		[
			["u_8812", 44],
			["u_1093", 31],
		],
	],
])

const RESOURCE_KEYS = ["service.name", "deployment.environment", "service.version", "k8s.pod.name"] as const

const ERRORS = [
	{
		fingerprintHash: FIXTURES.fingerprint,
		errorLabel: "TimeoutError",
		sampleMessage: "checkout timeout after 30000ms",
		count: 1_480,
		serviceNames: ["subscriptions-api", "checkout"],
	},
	{
		fingerprintHash: "4471203398812230011",
		errorLabel: "ConnectionResetError",
		sampleMessage: "connection reset by peer",
		count: 912,
		serviceNames: [FIXTURES.service],
	},
] as const

/** `YYYY-MM-DD HH:MM:SS` in UTC, `minutesAgo` before now: the warehouse's DateTime text. */
const chTime = (minutesAgo: number): string =>
	Str.replace("T", " ")(Str.slice(0, 19)(new Date(Date.now() - minutesAgo * 60_000).toISOString()))

/** The service a query filters to, when it filters to one. */
const filteredService = (sql: string): string | undefined =>
	/ServiceName (?:= |IN \()'([^']+)'/.exec(sql)?.[1]

const servicesFor = (sql: string): ReadonlyArray<WorldService> => {
	const only = filteredService(sql)
	return only === undefined
		? WORLD_SERVICES
		: Arr.filter(WORLD_SERVICES, (service) => service.name === only)
}

const serviceRow = (service: WorldService) => ({
	serviceName: service.name,
	environment: "production",
	serviceNamespace: "",
	throughput: service.throughput,
	errorCount: service.errors,
	estimatedErrorCount: service.errors,
	spanCount: service.throughput,
	p50LatencyMs: service.p50,
	p95LatencyMs: service.p95,
	p99LatencyMs: service.p99,
	estimatedSpanCount: service.throughput,
	firstSeen: chTime(60 * 24 * 30),
	commits: [],
})

/** A breakdown row; an operation inherits its service's error rate and latency. */
const breakdownRow = (name: string, count: number, service: WorldService) => ({
	name,
	count,
	spanCount: count,
	avgDuration: service.p50 * 1.4,
	p50Duration: service.p50,
	p95Duration: service.p95,
	p99Duration: service.p99,
	errorRate: service.errors / service.throughput,
	satisfiedCount: Math.round(count * 0.9),
	toleratingCount: Math.round(count * 0.05),
	apdexScore: 0.92,
})

const errorRow = (error: (typeof ERRORS)[number]) => ({
	fingerprintHash: error.fingerprintHash,
	errorLabel: error.errorLabel,
	sampleMessage: error.sampleMessage,
	count: error.count,
	affectedServicesCount: error.serviceNames.length,
	serviceNames: error.serviceNames,
	firstSeen: chTime(60 * 24 * 3),
	lastSeen: chTime(2),
})

const freshnessRows = (sql: string) =>
	Arr.map(
		Arr.filter(["traces", "logs", "metrics"] as const, (signal) =>
			Str.includes(`'${signal}' AS signal`)(sql),
		),
		(signal) => ({ signal, count: 250_000, firstSeen: chTime(60 * 24 * 7), lastSeen: chTime(1) }),
	)

/** The world, as fake-warehouse rules. Put these before any catch-all. */
export const worldRules = (): FixtureRule[] => [
	{ match: (sql) => Str.includes("AS signal")(sql), rows: freshnessRows },
	{
		match: (sql) => Str.includes("AS serviceName")(sql) && Str.includes("service_commit_rows")(sql),
		rows: (sql) => Arr.map(servicesFor(sql), serviceRow),
	},
	{
		match: (sql) => Str.includes("AS facetType")(sql),
		rows: [
			{ name: "production", count: 396_300, facetType: "environment" },
			...Arr.map(WORLD_SERVICES, (service) => ({
				name: service.name,
				count: service.throughput,
				facetType: "service",
			})),
		],
	},
	{
		// An aggregate with no GROUP BY answers one row even when nothing matches, as ClickHouse does.
		match: (sql) => Str.includes("FROM error_events")(sql) && Str.includes("AS noExceptionCount")(sql),
		rows: (sql) => {
			const fingerprint = /FingerprintHash = toUInt64\('(\d+)'\)/.exec(sql)?.[1]
			return [
				Option.match(
					Arr.findFirst(ERRORS, (candidate) => candidate.fingerprintHash === fingerprint),
					{
						onNone: () => ({
							occurrences: 0,
							firstSeen: "1970-01-01 00:00:00",
							lastSeen: "1970-01-01 00:00:00",
							errorLabel: "",
							exceptionType: "",
							exceptionMessage: "",
							statusMessage: "",
							serviceCount: 0,
							services: [],
							noExceptionCount: 0,
						}),
						onSome: (error) => ({
							occurrences: error.count,
							firstSeen: chTime(60 * 24 * 3),
							lastSeen: chTime(2),
							errorLabel: error.errorLabel,
							exceptionType: error.errorLabel,
							exceptionMessage: error.sampleMessage,
							statusMessage: error.sampleMessage,
							serviceCount: error.serviceNames.length,
							services: error.serviceNames,
							noExceptionCount: 0,
						}),
					},
				),
			]
		},
	},
	{
		match: (sql) => Str.includes("AS attributeKey")(sql),
		rows: (sql) =>
			Arr.map(
				Str.includes("resource_attribute")(sql) || /AttributeScope = 'resource'/.test(sql)
					? Arr.map(RESOURCE_KEYS, (key) => [key, 400_000] as const)
					: Arr.map(
							[...ATTRIBUTE_VALUES],
							([key, values]) => [key, Arr.reduce(values, 0, (sum, [, n]) => sum + n)] as const,
						),
				([attributeKey, usageCount]) => ({ attributeKey, usageCount }),
			),
	},
	{
		match: (sql) => Str.includes("AS attributeValue")(sql),
		rows: (sql) => {
			const key = /AttributeKey = '([^']+)'/.exec(sql)?.[1] ?? ""
			return Arr.map(ATTRIBUTE_VALUES.get(key) ?? [], ([attributeValue, usageCount]) => ({
				attributeValue,
				usageCount,
			}))
		},
	},
	{
		match: (sql) =>
			Str.includes("AS fingerprintHash")(sql) && Str.includes("AS affectedServicesCount")(sql),
		rows: (sql) => {
			const only = filteredService(sql)
			return Arr.map(
				Arr.filter(
					ERRORS,
					(error) => only === undefined || Arr.some(error.serviceNames, (name) => name === only),
				),
				errorRow,
			)
		},
	},
	{
		match: (sql) => Str.includes("AS distinctErrorCount")(sql),
		rows: [{ occurrences: 2_392, distinctErrorCount: ERRORS.length, noExceptionCount: 0 }],
	},
	{
		// query_data traces breakdowns, by service or by operation.
		match: (sql) =>
			Str.includes("FROM traces")(sql) &&
			Str.includes("AS errorRate")(sql) &&
			!Str.includes("AS bucket")(sql),
		rows: (sql) =>
			Str.includes("SpanName AS name")(sql)
				? Arr.flatMap(servicesFor(sql), (service) =>
						Arr.map(service.operations, ([name, count]) => breakdownRow(name, count, service)),
					)
				: Arr.map(servicesFor(sql), (service) =>
						breakdownRow(service.name, service.throughput, service),
					),
	},
	{
		match: (sql) => Str.includes("SpanName AS name")(sql) && filteredService(sql) !== undefined,
		rows: (sql) =>
			Arr.flatMap(servicesFor(sql), (service) =>
				Arr.map(service.operations, ([name, value]) => ({ name, value })),
			),
	},
]

/**
 * The world's Postgres side: the error issue the issue tasks name, tracking the checkout timeout.
 * Without it an agent that looks before it acts (the right habit) gets "not found" and drifts.
 */
export const seedWorld = (rt: EvalRuntime) =>
	executeSql(
		rt.testDb,
		`INSERT INTO error_issues (id, org_id, kind, fingerprint_hash, service_name, exception_type,
			exception_message, error_label, top_frame, first_seen_at, last_seen_at, created_at, updated_at)
		 VALUES ($1, $2, 'error', $3, 'checkout', 'TimeoutError', $4, 'TimeoutError', '', $5, $6, $5, $6)`,
		[
			FIXTURES.issueId,
			FIXTURES.orgId,
			FIXTURES.fingerprint,
			"checkout timeout after 30000ms",
			new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
			new Date(Date.now() - 2 * 60_000).toISOString(),
		],
	)
