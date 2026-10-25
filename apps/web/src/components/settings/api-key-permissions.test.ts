import { UserId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { apiKeyRowPermissions } from "./api-key-permissions"

const ME = Schema.decodeSync(UserId)("user_me")
const OTHER = Schema.decodeSync(UserId)("user_other")
const live = { revoked: false, created_by: ME }

describe("apiKeyRowPermissions", () => {
	it("lets an admin roll and revoke any live key", () => {
		expect(
			apiKeyRowPermissions(
				{ ...live, kind: "standard", created_by: OTHER },
				{ isAdmin: true, userId: ME },
			),
		).toEqual({ canRoll: true, canRevoke: true })
	})

	it("lets a member revoke only their own MCP key, and never roll", () => {
		const member = { isAdmin: false, userId: ME }
		expect(apiKeyRowPermissions({ ...live, kind: "mcp" }, member)).toEqual({
			canRoll: false,
			canRevoke: true,
		})
		expect(apiKeyRowPermissions({ ...live, kind: "mcp", created_by: OTHER }, member)).toEqual({
			canRoll: false,
			canRevoke: false,
		})
		expect(apiKeyRowPermissions({ ...live, kind: "standard" }, member)).toEqual({
			canRoll: false,
			canRevoke: false,
		})
	})

	it("lets a member revoke their own phone's device key; an admin revokes any but rolls none", () => {
		expect(apiKeyRowPermissions({ ...live, kind: "device" }, { isAdmin: false, userId: ME })).toEqual({
			canRoll: false,
			canRevoke: true,
		})
		expect(
			apiKeyRowPermissions(
				{ ...live, kind: "device", created_by: OTHER },
				{ isAdmin: false, userId: ME },
			),
		).toEqual({ canRoll: false, canRevoke: false })
		expect(
			apiKeyRowPermissions(
				{ ...live, kind: "device", created_by: OTHER },
				{ isAdmin: true, userId: ME },
			),
		).toEqual({ canRoll: false, canRevoke: true })
	})

	it("offers nothing on a revoked key or before the session names the viewer", () => {
		expect(
			apiKeyRowPermissions({ ...live, kind: "mcp", revoked: true }, { isAdmin: true, userId: ME }),
		).toEqual({
			canRoll: false,
			canRevoke: false,
		})
		expect(
			apiKeyRowPermissions({ ...live, kind: "mcp" }, { isAdmin: false, userId: null }).canRevoke,
		).toBe(false)
	})
})
