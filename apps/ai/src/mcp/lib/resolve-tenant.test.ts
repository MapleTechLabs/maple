import { describe, expect, it } from "@effect/vitest"
import { describeMalformedBearer } from "./resolve-tenant"

describe("describeMalformedBearer", () => {
	it("names an unexpanded environment placeholder and the key format", () => {
		const message = describeMalformedBearer("${MAPLE_API_KEY}")
		expect(message).toContain("unexpanded placeholder")
		expect(message).toContain("maple_ak_")
		expect(describeMalformedBearer("$MAPLE_API_KEY")).toContain("unexpanded placeholder")
		expect(describeMalformedBearer("<your-api-key>")).toContain("unexpanded placeholder")
	})

	it("rejects a string that is neither a Maple key nor a JWT", () => {
		const message = describeMalformedBearer("not-a-key")
		expect(message).toContain("not a Maple API key")
		expect(message).toContain("maple_ak_")
	})

	it("lets Maple keys, JWTs and absent tokens through to the lookup", () => {
		expect(describeMalformedBearer("maple_ak_abc123")).toBeUndefined()
		expect(describeMalformedBearer("aaa.bbb.ccc")).toBeUndefined()
		expect(describeMalformedBearer(undefined)).toBeUndefined()
	})
})
