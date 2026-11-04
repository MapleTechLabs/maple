import { describe, expect, it } from "vitest"
import { resolveUsersScope, signalsOf } from "./users-reads"

const rows = [
	{ service: "web", namespace: "storefront" },
	{ service: "api", namespace: "platform" },
	{ service: "web", namespace: "checkout" },
]

describe("resolveUsersScope", () => {
	it("scopes to every service that emitted under a picked namespace", () => {
		const scope = resolveUsersScope(["checkout", "platform"], rows, ["mcp"])
		expect(scope.services).toEqual(["api", "web"])
		expect(scope.mcpServices).toEqual(["mcp"])
	})

	it("labels a service with its busiest namespace", () => {
		expect(resolveUsersScope([], rows, []).serviceNamespaces).toEqual([
			["web", "storefront"],
			["api", "platform"],
		])
	})

	it("resolves no services for a namespace nothing emitted under", () => {
		expect(resolveUsersScope(["nowhere"], rows, []).services).toEqual([])
	})
})

describe("signalsOf", () => {
	it("lists the sources that saw the user", () => {
		expect(signalsOf({ sessions: 2, events: 0, mcpSpans: 5 })).toEqual(["replay", "mcp"])
		expect(signalsOf({ sessions: 0, events: 1, mcpSpans: 0 })).toEqual(["events"])
	})
})
