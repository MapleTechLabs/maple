import { describe, expect, it } from "vitest"
import { readJwtExpMs } from "./auth-headers"
import { String as Str } from "effect"

const base64Url = (value: string): string =>
	Str.replace(/=+$/, "")(Str.replace(/\//g, "_")(Str.replace(/\+/g, "-")(btoa(value))))

const jwtWithClaims = (claims: unknown): string => `header.${base64Url(JSON.stringify(claims))}.signature`

describe("readJwtExpMs", () => {
	it("reads `exp` seconds as epoch ms", () => {
		expect(readJwtExpMs(jwtWithClaims({ exp: 1_700_000_000, sub: "user_1" }))).toBe(1_700_000_000_000)
	})

	it("has no deadline for a token without a numeric `exp`", () => {
		expect(readJwtExpMs(jwtWithClaims({ sub: "user_1" }))).toBeUndefined()
		expect(readJwtExpMs(jwtWithClaims({ exp: "soon" }))).toBeUndefined()
	})

	it("has no deadline for an opaque or malformed token", () => {
		expect(readJwtExpMs("opaque-session-token")).toBeUndefined()
		expect(readJwtExpMs("header.!!not-base64!!.signature")).toBeUndefined()
		expect(readJwtExpMs(`header.${base64Url("[1, 2]")}.signature`)).toBeUndefined()
	})
})
