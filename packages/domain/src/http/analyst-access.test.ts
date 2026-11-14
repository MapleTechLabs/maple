import { describe, expect, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { MapleApi } from "./api"
import { MapleInternalApi } from "./internal-api"
import { isOpenToAnalysts } from "./analyst-access"
import { MapleApiV2 } from "./v2/api"

type Called = Parameters<typeof isOpenToAnalysts>[0]
type Group = Called["group"] & {
	readonly endpoints: { readonly [name: string]: Called["endpoint"] & { readonly identifier: string } }
}

// @effect-diagnostics-next-line preferEffectRecord:off -- not a record type; Rec.values would need a cast
const endpointsOf = (group: Group) => Object.values(group.endpoints)

const open = (group: Group, name: string): boolean =>
	Arr.some(
		endpointsOf(group),
		(endpoint) => endpoint.identifier === name && isOpenToAnalysts({ group, endpoint }),
	)

const internal = MapleInternalApi.groups
const v2 = MapleApiV2.groups

describe("isOpenToAnalysts", () => {
	it("lets an analyst run every dashboard query, which are all POSTs", () => {
		const queries = endpointsOf(internal.queryEngine)
		expect(queries.length).toBeGreaterThan(0)
		expect(
			Arr.every(queries, (endpoint) => isOpenToAnalysts({ group: internal.queryEngine, endpoint })),
		).toBe(true)
	})

	it("refuses the work of running the product: issue triage, SLOs and alert rules", () => {
		expect(open(internal.errors, "transitionIssue")).toBe(false)
		expect(open(internal.errors, "commentOnIssue")).toBe(false)
		expect(open(v2.slos, "create")).toBe(false)
		expect(open(v2.alertRules, "create")).toBe(false)
	})

	it("lets an analyst change dashboards in every way a member can", () => {
		const writes = [
			"create",
			"importPerses",
			"instantiateTemplate",
			"update",
			"delete",
			"restoreVersion",
			"upsertShare",
			"rotateShare",
			"revokeShare",
			"upsertWidgetShare",
			"rotateWidgetShare",
			"revokeWidgetShare",
		]
		expect(Arr.filter(writes, (name) => !open(v2.dashboards, name))).toEqual([])
	})

	it("keeps every GET of a group that also changes things", () => {
		const reads = Arr.filter(endpointsOf(internal.errors), (endpoint) => endpoint.method === "GET")
		expect(reads.length).toBeGreaterThan(0)
		expect(Arr.every(reads, (endpoint) => isOpenToAnalysts({ group: internal.errors, endpoint }))).toBe(
			true,
		)
	})

	it("allows a dry run that sits beside the writes it previews", () => {
		expect(open(internal.errors, "evaluateEscalationPolicy")).toBe(true)
		expect(open(internal.digest, "preview")).toBe(true)
	})

	it("lets an analyst manage their own digest, devices and connections", () => {
		expect(open(internal.digest, "upsertSubscription")).toBe(true)
		expect(open(internal.digest, "deleteSubscription")).toBe(true)
		expect(open(v2.mobileDevices, "register")).toBe(true)
		expect(open(v2.mcpConnections, "revoke")).toBe(true)
		expect(open(MapleApi.groups.authSession, "cliDeviceApprove")).toBe(true)
	})
})
