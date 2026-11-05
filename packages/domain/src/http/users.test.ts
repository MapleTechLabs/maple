import { Schema, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { EndUserId, UsersListKeyset } from "./users"

describe("UsersListKeyset", () => {
	it("accepts every user id the user routes accept, so any page can hand out a cursor", () => {
		const longest = Str.repeat(512)("u")
		expect(Schema.decodeUnknownSync(EndUserId)(longest)).toBe(longest)
		const position = { lastSeen: "2026-11-01 09:00:00.123456789", userId: longest }
		expect(Schema.decodeUnknownSync(UsersListKeyset)(position)).toEqual(position)
	})
})
