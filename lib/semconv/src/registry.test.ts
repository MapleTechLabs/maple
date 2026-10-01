import { describe, expect, it } from "vitest"
import { attributeStatus, canonicalKey, isRegistryKey, legacyKeys, REGISTRY_VERSIONS } from "./index.ts"

describe("attributeStatus", () => {
	it("reports a live key as current", () => {
		expect(attributeStatus("http.request.method")).toMatchObject({
			kind: "current",
			definition: { registry: "semconv", stability: "stable" },
		})
	})

	it("reports a renamed key with its successor", () => {
		expect(attributeStatus("http.method")).toMatchObject({
			kind: "deprecated",
			successors: ["http.request.method"],
			definition: { deprecation: { reason: "renamed" } },
		})
	})

	// The replacement is only named in the note's prose for these.
	it("reads a successor out of an uncategorized deprecation note", () => {
		expect(attributeStatus("gen_ai.system")).toMatchObject({
			kind: "deprecated",
			successors: ["gen_ai.provider.name"],
		})
		expect(attributeStatus("rpc.grpc.status_code")).toMatchObject({
			kind: "deprecated",
			successors: ["rpc.response.status_code"],
		})
	})

	// semconv v1.44.0 moved gen_ai.* to its own registry and left deprecated stubs.
	it("treats a key that moved to the GenAI registry as current", () => {
		expect(attributeStatus("gen_ai.request.model")).toMatchObject({
			kind: "moved",
			definition: { registry: "genai" },
		})
	})

	it("reports an obsoleted key with no successor", () => {
		expect(attributeStatus("http.flavor")).toMatchObject({ kind: "deprecated" })
	})

	it("resolves keys under a template attribute", () => {
		expect(attributeStatus("http.request.header.x-request-id")).toMatchObject({
			kind: "current",
			definition: { id: "http.request.header" },
		})
	})

	it("remembers keys the registry dropped without a deprecation", () => {
		expect(attributeStatus("gen_ai.token.type")).toEqual({
			kind: "removed",
			registry: "genai",
			lastSeenVersion: "2026-09-01",
		})
	})

	it("reports vendor and application keys as unknown", () => {
		expect(attributeStatus("maple.org_id")).toEqual({ kind: "unknown" })
		expect(isRegistryKey("maple.org_id")).toBe(false)
		expect(isRegistryKey("http.method")).toBe(true)
	})
})

describe("canonicalKey", () => {
	it("follows renames to the live key", () => {
		expect(canonicalKey("db.system")).toBe("db.system.name")
		expect(canonicalKey("deployment.environment")).toBe("deployment.environment.name")
		expect(canonicalKey("peer.service")).toBe("service.peer.name")
	})

	it("leaves current, unknown and successor-less keys alone", () => {
		expect(canonicalKey("db.system.name")).toBe("db.system.name")
		expect(canonicalKey("maple.org_id")).toBe("maple.org_id")
		expect(canonicalKey("http.flavor")).toBe("http.flavor")
	})
})

describe("legacyKeys", () => {
	it("lists every deprecated spelling that resolves to a key", () => {
		expect(legacyKeys("http.request.method")).toContain("http.method")
		expect(legacyKeys("db.system.name")).toContain("db.system")
		expect(legacyKeys("maple.org_id")).toEqual([])
	})

	it("never lists a key as its own legacy spelling", () => {
		expect(legacyKeys("db.system.name")).not.toContain("db.system.name")
	})
})

describe("snapshot", () => {
	it("records the registry versions it was taken at", () => {
		expect(REGISTRY_VERSIONS.semconv).toMatch(/^\d+\.\d+\.\d+$/)
		expect(REGISTRY_VERSIONS.genai).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})
})
