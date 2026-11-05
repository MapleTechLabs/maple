import { Exit, Schema, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { EndUserId, UsersListCursor, UsersListKeyset } from "./users"

describe("UsersListKeyset", () => {
	it("accepts every user id the user routes accept, so any page can hand out a cursor", () => {
		const longest = Str.repeat(512)("u")
		expect(Schema.decodeSync(EndUserId)(longest)).toBe(longest)
		const position = { lastSeen: "2026-11-01 09:00:00.123456789", userId: longest }
		expect(Schema.decodeSync(UsersListKeyset)(position)).toEqual(position)
	})
})

describe("UsersListCursor", () => {
	it("round-trips a keyset as one opaque token and refuses a tampered one", () => {
		const position = { lastSeen: "2026-11-01 09:00:00.123456789", userId: "user/42 ada" }
		const token = Schema.encodeSync(UsersListCursor)(position)
		expect(Schema.decodeSync(UsersListCursor)(token)).toEqual(position)
		expect(Exit.isFailure(Schema.decodeExit(UsersListCursor)("bm90LWpzb24"))).toBe(true)
	})
})
