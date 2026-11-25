import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Option } from "effect"
import * as Policy from "../policy"
import { MapleAiApi } from "./ai-api"
import { MapleApi } from "./api"
import { Authorization, RegionlessSessionAuthorization, SessionAuthorization } from "./current-tenant"
import {
	type CalledEndpoint,
	decideEndpointAccess,
	EndpointAccess,
	endpointAccessRules,
	requires,
	ScopedTelemetry,
} from "./endpoint-access"
import { MapleInternalApi } from "./internal-api"
import { AuthorizationV2 } from "./v2/auth"
import { MapleApiV2 } from "./v2/api"

type Endpoint = CalledEndpoint["endpoint"] & {
	readonly identifier: string
	readonly middlewares: ReadonlySet<unknown>
}
type Group = CalledEndpoint["group"] & {
	readonly identifier: string
	readonly endpoints: { readonly [name: string]: Endpoint }
}

/** The middlewares that resolve a tenant, and so run the endpoint gate. */
const gated: ReadonlyArray<unknown> = [
	Authorization,
	SessionAuthorization,
	RegionlessSessionAuthorization,
	AuthorizationV2,
]

const apis = [MapleApi, MapleInternalApi, MapleApiV2, MapleAiApi] as const

const allEndpoints = Arr.flatMap(apis, (api) =>
	// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.values would need a cast
	Arr.flatMap(Object.values(api.groups) as ReadonlyArray<Group>, (group) =>
		// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.values would need a cast
		Arr.map(Object.values(group.endpoints), (endpoint) => ({ group, endpoint })),
	),
)

const find = (group: Group, name: string): CalledEndpoint => ({
	group,
	endpoint: Option.getOrThrow(Option.fromNullishOr(group.endpoints[name])),
})

const internal = MapleInternalApi.groups
const v2 = MapleApiV2.groups

/** What a member on a role limited to namespaces holds: the scoped read, and nothing that needs telemetry. */
const LIMITED: Policy.Grants = Policy.grantsOf(
	[Policy.CUSTOM_ROLE_CLERK_KEY],
	Policy.decodeCustomPermissions(Policy.encodePermissions([Policy.SCOPED_READ, "devices:connect"])),
)

const isScopeAware = ({ endpoint }: { readonly endpoint: Endpoint }): boolean =>
	Context.get(endpoint.annotations, ScopedTelemetry)

const nameOf = ({ group, endpoint }: { readonly group: Group; readonly endpoint: Endpoint }): string =>
	`${group.identifier}.${endpoint.identifier}`

const ANALYST = Policy.grantsOf(["org:analyst"])
const MEMBER = Policy.grantsOf(["org:member"])

describe("EndpointAccess", () => {
	it("marks every gated endpoint that is not a GET", () => {
		const unmarked = Arr.filter(
			allEndpoints,
			({ group, endpoint }) =>
				endpoint.method !== "GET" &&
				endpoint.method !== "HEAD" &&
				Arr.some(gated, (middleware) => endpoint.middlewares.has(middleware)) &&
				endpointAccessRules({ group, endpoint }).length === 0,
		)
		expect(
			Arr.map(unmarked, ({ group, endpoint }) => `${group.identifier}.${endpoint.identifier}`),
		).toEqual([])
	})

	it("needs telemetry:read for a configuration read whose group the handler checks", () => {
		const billingOnly: Policy.Grants = ["billing:manage"]
		for (const called of [
			find(v2.alertRules, "list"),
			find(v2.alertDestinations, "list"),
			find(v2.apiKeys, "list"),
			find(v2.slos, "list"),
			find(v2.sources, "list"),
			find(v2.ingestRules, "stats"),
		]) {
			expect(decideEndpointAccess(billingOnly, called)).toEqual({
				_tag: "Denied",
				permission: "telemetry:read",
			})
			expect(decideEndpointAccess(ANALYST, called)._tag).toBe("Allowed")
		}
	})

	it("leaves a read marked personal open to a role without telemetry:read", () => {
		const billingOnly: Policy.Grants = ["billing:manage"]
		for (const called of [
			find(internal.billing, "getUsage"),
			find(v2.organization, "retrieve"),
			find(v2.mcpConnections, "list"),
		]) {
			expect(decideEndpointAccess(billingOnly, called)._tag).toBe("Allowed")
		}
	})

	it("needs the public ingest key permission, not telemetry, to read the public key", () => {
		const called = find(v2.ingestKeys, "retrievePublic")
		expect(decideEndpointAccess(["ingest_keys:view_public"], called)._tag).toBe("Allowed")
		expect(decideEndpointAccess(["telemetry:read"], called)).toEqual({
			_tag: "Denied",
			permission: "ingest_keys:view_public",
		})
	})

	it("needs telemetry:read for a dashboard query and query:sql for raw SQL", () => {
		const batch = find(internal.queryEngine, "executeBatch")
		const rawSql = find(internal.queryEngine, "executeRawSql")
		expect(decideEndpointAccess(ANALYST, batch)._tag).toBe("Allowed")
		expect(decideEndpointAccess([], batch)).toEqual({ _tag: "Denied", permission: "telemetry:read" })
		expect(decideEndpointAccess(["telemetry:read"], rawSql)).toEqual({
			_tag: "Denied",
			permission: "query:sql",
		})
	})

	it("needs telemetry:read for a v2 trace read, GETs included", () => {
		expect(decideEndpointAccess(["dashboards:edit"], find(v2.traces, "retrieve"))).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
	})

	it("needs dashboards:edit and the group's telemetry:read to create a dashboard", () => {
		const create = find(v2.dashboards, "create")
		expect(decideEndpointAccess(ANALYST, create)._tag).toBe("Allowed")
		expect(decideEndpointAccess(["dashboards:edit"], create)).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
		expect(decideEndpointAccess(["telemetry:read"], create)).toEqual({
			_tag: "Denied",
			permission: "dashboards:edit",
		})
	})

	it("needs investigations:run and the group's telemetry:read to start an investigation", () => {
		const create = find(v2.investigations, "create")
		expect(decideEndpointAccess(MEMBER, create)._tag).toBe("Allowed")
		expect(decideEndpointAccess(["investigations:run"], create)).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
		expect(decideEndpointAccess(ANALYST, create)).toEqual({
			_tag: "Denied",
			permission: "investigations:run",
		})
	})

	it("needs telemetry:read beside devices:connect to register a phone for alert pushes", () => {
		for (const name of ["register", "registerLiveActivity"]) {
			const endpoint = find(v2.mobileDevices, name)
			expect(decideEndpointAccess(["devices:connect"], endpoint)).toEqual({
				_tag: "Denied",
				permission: "telemetry:read",
			})
			expect(decideEndpointAccess(["telemetry:read"], endpoint)).toEqual({
				_tag: "Denied",
				permission: "devices:connect",
			})
			expect(decideEndpointAccess(ANALYST, endpoint)._tag).toBe("Allowed")
		}
		// Signing out stays open to everyone.
		expect(decideEndpointAccess(["devices:connect"], find(v2.mobileDevices, "unregister"))._tag).toBe(
			"Allowed",
		)
	})

	it("keeps the group's telemetry:read on an endpoint its handler checks", () => {
		const upsert = find(internal.errors, "upsertEscalationPolicy")
		expect(decideEndpointAccess(["error_policy:manage"], upsert)).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
		expect(decideEndpointAccess(["telemetry:read"], upsert)._tag).toBe("Allowed")
	})

	it("needs telemetry:read to read a Supabase project's query insights", () => {
		const insights = find(internal.integrations, "supabaseProjectInsights")
		expect(decideEndpointAccess(["integrations:manage"], insights)).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
		expect(decideEndpointAccess(ANALYST, insights)._tag).toBe("Allowed")
	})

	it("needs telemetry:read for every code review read: CI traces and post-merge telemetry", () => {
		for (const name of [
			"analytics",
			"listReviews",
			"getReview",
			"listFindings",
			"ciAnalytics",
			"ciRuns",
			"team",
		]) {
			expect(decideEndpointAccess(["code_review:configure"], find(internal.codeReview, name))).toEqual({
				_tag: "Denied",
				permission: "telemetry:read",
			})
			expect(decideEndpointAccess(ANALYST, find(internal.codeReview, name))._tag).toBe("Allowed")
		}
	})

	it("needs telemetry:read for reads that return telemetry beside integration and monitor setup", () => {
		const reads = [
			find(internal.integrations, "cloudflareUsage"),
			find(v2.awsIntegration, "ingest"),
			find(v2.uptimeMonitors, "list"),
			find(v2.uptimeMonitors, "retrieve"),
		]
		for (const read of reads) {
			expect(decideEndpointAccess(["integrations:manage", "uptime_monitors:manage"], read)).toEqual({
				_tag: "Denied",
				permission: "telemetry:read",
			})
			expect(decideEndpointAccess(ANALYST, read)._tag).toBe("Allowed")
		}
	})

	it("needs telemetry:read for reads of org data derived from telemetry", () => {
		const reads = [
			find(v2.statusPages, "view"),
			find(internal.costBudgets, "list"),
			find(internal.integrations, "vcsCommitDetail"),
			find(internal.integrations, "vcsCommitDetails"),
			find(internal.integrations, "vcsCommitRanges"),
			find(internal.integrations, "vcsPullRequests"),
			find(internal.integrations, "cloudflareHyperdrives"),
			find(internal.integrations, "vercelDeployments"),
			find(internal.integrations, "gcpResources"),
			find(v2.sources, "usage"),
			find(v2.sources, "usageSummary"),
			find(v2.scrapeTargets, "listChecks"),
		]
		for (const read of reads) {
			expect(decideEndpointAccess([], read)).toEqual({ _tag: "Denied", permission: "telemetry:read" })
			expect(decideEndpointAccess(ANALYST, read)._tag).toBe("Allowed")
		}
	})

	it("needs dashboards:share to publish a share link", () => {
		const share = find(v2.dashboards, "upsertShare")
		expect(decideEndpointAccess(ANALYST, share)._tag).toBe("Allowed")
		expect(decideEndpointAccess(["dashboards:edit"], share)).toEqual({
			_tag: "Denied",
			permission: "dashboards:share",
		})
	})

	it("refuses an analyst issue triage, which a member holds", () => {
		const transition = find(internal.errors, "transitionIssue")
		expect(decideEndpointAccess(ANALYST, transition)).toEqual({
			_tag: "Denied",
			permission: "error_issues:triage",
		})
		expect(decideEndpointAccess(MEMBER, transition)._tag).toBe("Allowed")
	})

	it("leaves a billing write to its handler, which checks billing:manage", () => {
		const controls = find(internal.billing, "updateBillingControls")
		expect(decideEndpointAccess(ANALYST, controls)._tag).toBe("Allowed")
	})
})

describe("a role limited to namespaces", () => {
	const gatedEndpoints = Arr.filter(allEndpoints, ({ endpoint }) =>
		Arr.some(gated, (middleware) => endpoint.middlewares.has(middleware)),
	)
	const scopeAware = Arr.filter(gatedEndpoints, isScopeAware)

	it("is refused every endpoint that asks for telemetry:read and is not marked for it", () => {
		const withoutScopedRead: Policy.Grants = ["devices:connect"]
		// What the scoped read opens: endpoints it may call that the same role without it may not.
		const opened = Arr.filter(
			gatedEndpoints,
			(called) =>
				decideEndpointAccess(LIMITED, called)._tag === "Allowed" &&
				decideEndpointAccess(withoutScopedRead, called)._tag !== "Allowed",
		)
		expect(Arr.map(opened, nameOf).sort()).toEqual(Arr.map(scopeAware, nameOf).sort())
	})

	// Each one answers only from warehouse datasources that carry a namespace on every row.
	// Opening another is a decision to make here, not a mark to add in passing.
	it("reaches exactly the dashboard reads that can be kept to its namespaces", () => {
		const reached = Arr.filter(
			gatedEndpoints,
			(called) => decideEndpointAccess(LIMITED, called)._tag === "Allowed" && isScopeAware(called),
		)
		expect(Arr.map(reached, ({ endpoint }) => endpoint.identifier).sort()).toEqual([
			"errorRateByService",
			"executeBatch",
			"getLog",
			"listLogs",
			"metricDistribution",
			"metricExemplars",
			"releasesList",
			"serviceApdex",
			"serviceDeploys",
			"serviceDetailOverview",
			"serviceHealthBaseline",
			"serviceOverview",
			"serviceRuntimes",
			"spanDetail",
			"spanHierarchy",
			"traceSpanEvents",
		])
	})

	it("stays out of everything that reads more than the warehouse", () => {
		for (const called of [
			find(internal.queryEngine, "executeRawSql"),
			find(internal.queryEngine, "serviceMapBundle"),
			// Rollups that only name a service: a service name is not a namespace.
			find(internal.queryEngine, "errorsByType"),
			find(internal.queryEngine, "listMetrics"),
			find(internal.queryEngine, "serviceUsage"),
			find(internal.queryEngine, "costTotals"),
			find(internal.queryEngine, "productEventsFunnel"),
			find(v2.traces, "retrieve"),
			find(v2.alertRules, "list"),
			find(v2.dashboards, "create"),
			find(v2.investigations, "create"),
			find(internal.errors, "upsertEscalationPolicy"),
		]) {
			expect(decideEndpointAccess(LIMITED, called)._tag).toBe("Denied")
		}
	})

	it("is only ever let in by an endpoint's own mark, in a group that is session only", () => {
		expect(scopeAware.length).toBeGreaterThan(0)
		const elsewhere = Arr.filter(
			scopeAware,
			({ group, endpoint }) =>
				group.identifier !== "queryEngine" || !endpoint.middlewares.has(SessionAuthorization),
		)
		expect(Arr.map(elsewhere, nameOf)).toEqual([])
	})

	it("still needs every other permission a marked endpoint asks for", () => {
		const batch = find(internal.queryEngine, "executeBatch")
		const marked: CalledEndpoint = {
			group: batch.group,
			endpoint: {
				method: "POST",
				annotations: Context.make(ScopedTelemetry, true).pipe(
					Context.add(EndpointAccess, requires("telemetry:read", "query:sql")),
				),
			},
		}
		expect(decideEndpointAccess(LIMITED, marked)).toEqual({ _tag: "Denied", permission: "query:sql" })
		expect(decideEndpointAccess([Policy.SCOPED_READ, "billing:manage"], marked)).toEqual({
			_tag: "Denied",
			permission: "query:sql",
		})
	})

	it("is not let in by the mark alone: the caller has to hold the scoped read", () => {
		const batch = find(internal.queryEngine, "executeBatch")
		expect(decideEndpointAccess(["devices:connect"], batch)).toEqual({
			_tag: "Denied",
			permission: "telemetry:read",
		})
	})

	it("answers the read default of a marked GET too", () => {
		const batch = find(internal.queryEngine, "executeBatch")
		const markedGet: CalledEndpoint = {
			group: { annotations: Context.empty() },
			endpoint: { method: "GET", annotations: Context.make(ScopedTelemetry, true) },
		}
		expect(decideEndpointAccess(LIMITED, markedGet)._tag).toBe("Allowed")
		expect(
			decideEndpointAccess(LIMITED, {
				group: batch.group,
				endpoint: { method: "GET", annotations: Context.empty() },
			}),
		).toEqual({ _tag: "Denied", permission: "telemetry:read" })
	})
})
