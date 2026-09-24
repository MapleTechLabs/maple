/**
 * The check everything else in this connector stands on.
 *
 * The expected digest is computed HERE, from Slack's documented base string, rather than imported
 * from the module under test — so a bug in how the subject builds that string cannot also produce
 * the fixture that proves it right.
 */
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { MAX_TIMESTAMP_SKEW_SECONDS } from "./api"
import { verifySlackSignature } from "./signature"

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5"

/** Slack's own documented example body. */
const BODY =
	"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&api_app_id=A0F7YS25R&event=%7B%22type%22%3A%22app_mention%22%7D"

const NOW = 1_700_000_000_000

const seconds = (now: number) => String(Math.floor(now / 1000))

const sign = (timestamp: string, body: string, secret = SECRET) =>
	`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex")}`

const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
	verifySlackSignature({
		signature: sign(seconds(NOW), BODY),
		timestamp: seconds(NOW),
		body: BODY,
		signingSecret: SECRET,
		now: NOW,
		...overrides,
	})

describe("slack request signatures", () => {
	it("accepts a request signed with this app's secret", () => {
		expect(verify()).toEqual({ _tag: "ok" })
	})

	it("rejects a body that was changed after it was signed", () => {
		expect(verify({ body: `${BODY}&injected=1` })).toEqual({
			_tag: "rejected",
			reason: "signature mismatch",
		})
	})

	it("rejects a valid signature from a different app", () => {
		const timestamp = seconds(NOW)
		expect(verify({ signature: sign(timestamp, BODY, "another-apps-secret") })).toEqual({
			_tag: "rejected",
			reason: "signature mismatch",
		})
	})

	it("rejects a correctly signed request that is too old to be live", () => {
		// The whole point of the timestamp: this body's signature stays valid forever.
		const old = NOW - (MAX_TIMESTAMP_SKEW_SECONDS + 1) * 1000
		expect(verify({ signature: sign(seconds(old), BODY), timestamp: seconds(old) })).toEqual({
			_tag: "rejected",
			reason: "stale timestamp",
		})
	})

	it("rejects a timestamp from the future by the same margin", () => {
		const ahead = NOW + (MAX_TIMESTAMP_SKEW_SECONDS + 1) * 1000
		expect(verify({ signature: sign(seconds(ahead), BODY), timestamp: seconds(ahead) })).toEqual({
			_tag: "rejected",
			reason: "stale timestamp",
		})
	})

	it("accepts one right at the edge of the window", () => {
		const edge = NOW - MAX_TIMESTAMP_SKEW_SECONDS * 1000
		expect(verify({ signature: sign(seconds(edge), BODY), timestamp: seconds(edge) })).toEqual({
			_tag: "ok",
		})
	})

	it("refuses a timestamp that is not plain digits", () => {
		// `Number("1.7e12")` is a perfectly good instant, and nothing Slack ever sends.
		expect(verify({ timestamp: "1.7e12" })).toEqual({ _tag: "rejected", reason: "malformed timestamp" })
	})

	it("refuses a signature of the wrong shape before comparing anything", () => {
		// A constant-time compare throws on unequal lengths, so a short value must never reach it.
		expect(verify({ signature: "v0=deadbeef" })).toEqual({
			_tag: "rejected",
			reason: "malformed signature",
		})
		expect(verify({ signature: `v1=${"a".repeat(64)}` })).toEqual({
			_tag: "rejected",
			reason: "malformed signature",
		})
	})

	it("refuses a request that carries no signature or no timestamp at all", () => {
		expect(verify({ signature: undefined })).toEqual({ _tag: "rejected", reason: "missing signature" })
		expect(verify({ timestamp: undefined })).toEqual({ _tag: "rejected", reason: "missing timestamp" })
	})
})
