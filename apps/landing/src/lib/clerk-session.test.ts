import { describe, expect, it } from "vitest"
import { hasClerkSessionCookie, signedInUserId } from "./clerk-session"

describe("hasClerkSessionCookie", () => {
	it("reads Clerk's client timestamp, plain or this instance's suffix; zero is signed out", () => {
		expect(hasClerkSessionCookie("a=1; __client_uat=1730000000", "Ab3-xY_q")).toBe(true)
		expect(hasClerkSessionCookie("__client_uat_Ab3-xY_q=1730000000; b=2", "Ab3-xY_q")).toBe(true)
		expect(hasClerkSessionCookie("__client_uat_0ther000=1730000000", "Ab3-xY_q")).toBe(false)
		expect(hasClerkSessionCookie("__client_uat=0; __client_uat_Ab3-xY_q=0", "Ab3-xY_q")).toBe(false)
		expect(hasClerkSessionCookie("my__client_uat=17; __client_uatx=17", "Ab3-xY_q")).toBe(false)
	})
})

describe("signedInUserId", () => {
	it("names the user of an active session, as useAuth's isSignedIn does", () => {
		expect(signedInUserId({ session: { status: "active" }, user: { id: "user_1" } })).toBe("user_1")
		expect(signedInUserId({ session: { status: "pending" }, user: { id: "user_1" } })).toBeNull()
		expect(signedInUserId({ session: null, user: null })).toBeNull()
		expect(signedInUserId({ session: undefined, user: { id: "user_1" } })).toBeNull()
	})
})
