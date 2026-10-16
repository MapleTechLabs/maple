import { describe, expect, it } from "vitest"
import { mintUnsubscribeToken, unsubscribeLinks, verifyUnsubscribeToken } from "./unsubscribe-token"

const SECRET = "test-secret"
const SUB_ID = "4b7c1c2e-8f0a-4d7e-9b51-1f2a3b4c5d6e"

describe("unsubscribe tokens", () => {
	it("round-trips kind and subscription id", () => {
		const token = mintUnsubscribeToken(SECRET, "web-analytics", SUB_ID)
		expect(verifyUnsubscribeToken(SECRET, token)).toEqual({
			kind: "web-analytics",
			subscriptionId: SUB_ID,
		})
	})

	it("rejects a token signed with another secret", () => {
		expect(
			verifyUnsubscribeToken("other", mintUnsubscribeToken(SECRET, "digest", SUB_ID)),
		).toBeUndefined()
	})

	it("rejects a token whose kind or id was swapped", () => {
		const [, id, sig] = mintUnsubscribeToken(SECRET, "digest", SUB_ID).split(".")
		expect(verifyUnsubscribeToken(SECRET, `web-analytics.${id}.${sig}`)).toBeUndefined()
		expect(
			verifyUnsubscribeToken(SECRET, `digest.00000000-0000-4000-8000-000000000000.${sig}`),
		).toBeUndefined()
	})

	it("rejects malformed tokens", () => {
		for (const token of [
			"",
			"digest",
			`digest.${SUB_ID}`,
			`bogus.${SUB_ID}.abc`,
			`digest.${SUB_ID}.abc.d`,
		]) {
			expect(verifyUnsubscribeToken(SECRET, token)).toBeUndefined()
		}
	})

	it("builds a confirm page link and RFC 8058 one-click headers", () => {
		const links = unsubscribeLinks(
			{ secret: SECRET, appBaseUrl: "https://app.test", apiBaseUrl: "https://api.test" },
			"digest",
			SUB_ID,
		)
		expect(links.pageUrl).toMatch(/^https:\/\/app\.test\/unsubscribe\?token=digest\./)
		expect(links.headers["List-Unsubscribe"]).toMatch(
			/^<https:\/\/api\.test\/api\/email\/unsubscribe\?token=digest\..+>$/,
		)
		expect(links.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
	})
})
