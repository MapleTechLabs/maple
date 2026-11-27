import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import { type ApiKeyScopeFamily, apiKeyScopeFamilies, canGrantFamily, canGrantScopes } from "./api-key-scopes"
import type { Permission } from "./permissions"

/** What someone holding exactly `held` may put on a restricted key. */
const holding =
	(...held: ReadonlyArray<Permission>) =>
	(permission: Permission): boolean =>
		Arr.contains(held, permission)

const family = (id: ApiKeyScopeFamily["id"]): ApiKeyScopeFamily =>
	Option.getOrThrow(Arr.findFirst(apiKeyScopeFamilies, (one) => one.id === id))

describe("canGrantFamily", () => {
	it("needs the family's read permission to grant read", () => {
		expect(canGrantFamily(holding("telemetry:read"), family("dashboards"), "read")).toBe(true)
		expect(canGrantFamily(holding("dashboards:edit"), family("dashboards"), "read")).toBe(false)
	})

	it("needs both the read and the write permission to grant write", () => {
		const dashboards = family("dashboards")
		expect(canGrantFamily(holding("telemetry:read", "dashboards:edit"), dashboards, "write")).toBe(true)
		expect(canGrantFamily(holding("telemetry:read"), dashboards, "write")).toBe(false)
		expect(canGrantFamily(holding("dashboards:edit"), dashboards, "write")).toBe(false)
	})

	it("does not ask for a family's write permission to grant read", () => {
		expect(canGrantFamily(holding("ingest_keys:view"), family("ingest_keys"), "read")).toBe(true)
	})

	it("leaves a family that names no permission for an access open", () => {
		// Read on a write-only family, and write on a read-only one.
		expect(canGrantFamily(holding(), family("sources"), "read")).toBe(true)
		expect(canGrantFamily(holding(), family("sources"), "write")).toBe(false)
		expect(canGrantFamily(holding("telemetry:read"), family("traces"), "write")).toBe(true)
	})
})

describe("canGrantScopes", () => {
	const engineer = holding("telemetry:read", "dashboards:edit", "alerts:manage")

	it("allows a list only when every scope in it may be granted", () => {
		expect(canGrantScopes(engineer, ["dashboards:write", "alerts:read"])).toBe(true)
		expect(canGrantScopes(engineer, ["dashboards:write", "api_keys:write"])).toBe(false)
		expect(canGrantScopes(engineer, ["api_keys:write", "dashboards:write"])).toBe(false)
	})

	it("refuses a key that names no family: no scopes, an empty list", () => {
		expect(canGrantScopes(engineer, null)).toBe(false)
		expect(canGrantScopes(engineer, undefined)).toBe(false)
		expect(canGrantScopes(engineer, [])).toBe(false)
	})

	it("allows a single scope", () => {
		expect(canGrantScopes(engineer, ["dashboards:read"])).toBe(true)
	})

	it("refuses the wildcard, an unknown family and an access that is neither read nor write", () => {
		expect(canGrantScopes(engineer, ["*"])).toBe(false)
		expect(canGrantScopes(engineer, ["billing:read"])).toBe(false)
		expect(canGrantScopes(engineer, ["dashboards:admin"])).toBe(false)
		expect(canGrantScopes(engineer, ["dashboards"])).toBe(false)
		// Even beside scopes that are fine.
		expect(canGrantScopes(engineer, ["dashboards:read", "dashboards:admin"])).toBe(false)
		expect(canGrantScopes(engineer, ["dashboards:read", "billing:read"])).toBe(false)
	})

	it("reads the family from the scope, not from whichever family comes first", () => {
		expect(canGrantScopes(holding("audit_log:read"), ["audit_log:read"])).toBe(true)
		expect(canGrantScopes(holding("audit_log:read"), ["traces:read"])).toBe(false)
	})
})
