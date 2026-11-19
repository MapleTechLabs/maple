import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"
import * as Policy from "../policy"
import { MapleApi } from "./api"
import { Authorization, RegionlessSessionAuthorization, SessionAuthorization } from "./current-tenant"
import { type CalledEndpoint, decideEndpointAccess, endpointAccessOf } from "./endpoint-access"
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

const apis = [MapleApi, MapleInternalApi, MapleApiV2] as const

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
				endpointAccessOf({ group, endpoint }) === undefined,
		)
		expect(
			Arr.map(unmarked, ({ group, endpoint }) => `${group.identifier}.${endpoint.identifier}`),
		).toEqual([])
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
		expect(endpointAccessOf(controls)).toBe("handler")
		expect(decideEndpointAccess(ANALYST, controls)._tag).toBe("Allowed")
	})
})
