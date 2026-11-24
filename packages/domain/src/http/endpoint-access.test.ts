import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"
import * as Policy from "../policy"
import { MapleAiApi } from "./ai-api"
import { MapleApi } from "./api"
import { Authorization, RegionlessSessionAuthorization, SessionAuthorization } from "./current-tenant"
import { type CalledEndpoint, decideEndpointAccess, endpointAccessRules } from "./endpoint-access"
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
