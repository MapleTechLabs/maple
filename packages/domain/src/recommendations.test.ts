import { describe, expect, it } from "vitest"
import {
	type AttributeRecommendation,
	type ExistingIssueLike,
	detectAttributeRecommendations,
	planReconcileIssues,
} from "./recommendations"

const key = (attributeKey: string, usageCount = 1) => ({ attributeKey, usageCount })

describe("detectAttributeRecommendations", () => {
	it("recommends a rename when the deprecated key is present and the canonical is absent", () => {
		const recs = detectAttributeRecommendations([key("http.status_code", 42)], [])
		expect(recs).toHaveLength(1)
		expect(recs[0]).toMatchObject({
			id: "rename:http.status_code",
			kind: "rename",
			key: "http.status_code",
			canonical: "http.response.status_code",
			usageCount: 42,
			applyable: true,
		})
	})

	it("flags double-emission (not a rename) when both deprecated and canonical are present", () => {
		const recs = detectAttributeRecommendations(
			[key("http.status_code"), key("http.response.status_code")],
			[],
		)
		expect(recs).toHaveLength(1)
		expect(recs[0]).toMatchObject({
			id: "dual:http.status_code",
			kind: "double-emission",
			applyable: false,
		})
	})

	it("does not recommend anything when the deprecated key is absent", () => {
		const recs = detectAttributeRecommendations(
			[key("http.response.status_code"), key("service.name")],
			[],
		)
		expect(recs).toEqual([])
	})

	it("suppresses a recommendation whose key is already an existing mapping sourceKey", () => {
		const recs = detectAttributeRecommendations([key("http.status_code")], ["http.status_code"])
		expect(recs).toEqual([])
	})

	it("suppresses a recommendation whose id has been dismissed", () => {
		const recs = detectAttributeRecommendations(
			[key("http.status_code")],
			[],
			["rename:http.status_code"],
		)
		expect(recs).toEqual([])
	})

	it("maps common camelCase keys to a confident canonical target", () => {
		const recs = detectAttributeRecommendations([key("httpMethod", 7)], [])
		expect(recs).toHaveLength(1)
		expect(recs[0]).toMatchObject({
			id: "rename:httpMethod",
			kind: "rename",
			canonical: "http.request.method",
			applyable: true,
		})
	})

	it("flags generic camelCase keys as dismiss-only naming advisories", () => {
		const recs = detectAttributeRecommendations([key("customerId", 3)], [])
		expect(recs).toHaveLength(1)
		expect(recs[0]).toMatchObject({
			id: "naming:customerId",
			kind: "naming",
			applyable: false,
		})
		expect(recs[0]).not.toHaveProperty("canonical")
	})

	it("does not flag conforming lowercase dotted or snake_case keys as naming issues", () => {
		const recs = detectAttributeRecommendations(
			[key("service.name"), key("request_id"), key("environment")],
			[],
		)
		expect(recs).toEqual([])
	})

	it("caps generic naming advisories at 10, keeping the highest-usage keys", () => {
		const keys = Array.from({ length: 15 }, (_, i) => key(`customKey${i}`, i))
		const recs = detectAttributeRecommendations(keys, [])
		const naming = recs.filter((r) => r.kind === "naming")
		expect(naming).toHaveLength(10)
		expect(naming.map((r) => r.key)).toContain("customKey14")
		expect(naming.map((r) => r.key)).not.toContain("customKey0")
	})

	it("sorts renames first, then by usage desc, then key asc", () => {
		const recs = detectAttributeRecommendations(
			[key("http.method", 5), key("db.statement", 9), key("customId", 100)],
			[],
		)
		expect(recs.map((r) => r.kind)).toEqual(["rename", "rename", "naming"])
		expect(recs[0]!.key).toBe("db.statement")
		expect(recs[1]!.key).toBe("http.method")
		expect(recs[2]!.key).toBe("customId")
	})

	it("returns an empty array for empty input", () => {
		expect(detectAttributeRecommendations([], [])).toEqual([])
	})

	it("collapses multiple deprecated keys onto the same canonical target independently", () => {
		const recs = detectAttributeRecommendations([key("http.host"), key("net.peer.name")], [])
		expect(recs.map((r) => r.id).sort()).toEqual(["rename:http.host", "rename:net.peer.name"])
		const withTarget = detectAttributeRecommendations(
			[key("http.host"), key("net.peer.name"), key("server.address")],
			[],
		)
		expect(withTarget.every((r) => r.kind === "double-emission")).toBe(true)
	})
})

const rec = (over: Partial<AttributeRecommendation> & { id: string }): AttributeRecommendation => ({
	kind: "rename",
	key: "http.status_code",
	canonical: "http.response.status_code",
	reason: "",
	usageCount: 1,
	applyable: true,
	...over,
})

const issue = (over: Partial<ExistingIssueLike> & { id: string }): ExistingIssueLike => ({
	number: 1,
	recommendationKey: "rename:http.status_code",
	sourceKey: "http.status_code",
	status: "open",
	...over,
})

describe("planReconcileIssues", () => {
	it("inserts a newly detected recommendation with the next per-org number", () => {
		const plan = planReconcileIssues(
			[rec({ id: "rename:http.status_code", usageCount: 9 })],
			[
				issue({
					id: "x",
					number: 7,
					recommendationKey: "rename:db.statement",
					sourceKey: "db.statement",
				}),
			],
			[],
		)
		expect(plan.inserts).toHaveLength(1)
		expect(plan.inserts[0]).toMatchObject({
			number: 8,
			recommendationKey: "rename:http.status_code",
			kind: "rename",
			sourceKey: "http.status_code",
			canonicalKey: "http.response.status_code",
			usageCount: 9,
		})
		// db.statement issue no longer detected, was open → resolved.
		expect(plan.updates).toContainEqual({ id: "x", nextStatus: "resolved" })
	})

	it("refreshes usage for a still-detected open issue without changing status", () => {
		const plan = planReconcileIssues(
			[rec({ id: "rename:http.status_code", usageCount: 50 })],
			[issue({ id: "a", status: "open" })],
			[],
		)
		expect(plan.inserts).toEqual([])
		expect(plan.updates).toEqual([{ id: "a", usageCount: 50, nextStatus: undefined }])
	})

	it("reopens a resolved issue that is detected again", () => {
		const plan = planReconcileIssues(
			[rec({ id: "rename:http.status_code", usageCount: 3 })],
			[issue({ id: "a", status: "resolved" })],
			[],
		)
		expect(plan.updates).toEqual([{ id: "a", usageCount: 3, nextStatus: "open" }])
	})

	it("marks a vanished open issue applied when a mapping now covers its source key", () => {
		const plan = planReconcileIssues([], [issue({ id: "a", status: "open" })], ["http.status_code"])
		expect(plan.updates).toEqual([{ id: "a", nextStatus: "applied" }])
	})

	it("marks a vanished open issue resolved when no mapping covers it", () => {
		const plan = planReconcileIssues([], [issue({ id: "a", status: "open" })], [])
		expect(plan.updates).toEqual([{ id: "a", nextStatus: "resolved" }])
	})

	it("leaves a dismissed issue untouched even when no longer detected", () => {
		const plan = planReconcileIssues([], [issue({ id: "a", status: "dismissed" })], [])
		expect(plan.inserts).toEqual([])
		expect(plan.updates).toEqual([])
	})

	it("starts numbering at 1 when there are no existing issues", () => {
		const plan = planReconcileIssues([rec({ id: "rename:http.status_code" })], [], [])
		expect(plan.inserts[0]!.number).toBe(1)
	})
})
