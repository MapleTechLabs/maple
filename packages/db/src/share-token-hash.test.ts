import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AlertRuleId, OrgId } from "@maple/domain/primitives"
import {
	alertChartId,
	chatChartId,
	generateShareToken,
	hashShareToken,
	shareOgId,
	shareTokenSuffix,
	verifyAlertChartId,
	verifyChatChartId,
	verifyShareOgId,
} from "./share-token-hash"

const KEY = "test-share-hmac-key"
const SHARE_ID = "dshare_0f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f"

describe("hashShareToken", () => {
	it("is deterministic and keyed", () => {
		const token = generateShareToken()

		expect(hashShareToken(token, KEY)).toBe(hashShareToken(token, KEY))
		expect(hashShareToken(token, "other-key")).not.toBe(hashShareToken(token, KEY))
	})
})

describe("shareTokenSuffix", () => {
	it("keeps the last six characters", () => {
		expect(shareTokenSuffix("mshare_abcdefghij")).toBe("efghij")
	})
})

describe("shareOgId", () => {
	it("round-trips the share id", () => {
		expect(verifyShareOgId(shareOgId(SHARE_ID, KEY), KEY)).toBe(SHARE_ID)
	})

	it("never contains the share token", () => {
		const token = generateShareToken()

		expect(shareOgId(SHARE_ID, KEY)).not.toContain(token)
		expect(shareOgId(SHARE_ID, KEY)).not.toContain(hashShareToken(token, KEY))
	})

	it("rejects a tampered id, a tampered signature, and a foreign key", () => {
		const ogId = shareOgId(SHARE_ID, KEY)
		const [encodedId, signature] = ogId.split(".") as [string, string]
		const otherId = Buffer.from("dshare_someone-elses-share", "utf8").toString("base64url")

		expect(verifyShareOgId(`${otherId}.${signature}`, KEY)).toBeUndefined()
		expect(verifyShareOgId(`${encodedId}.${signature.slice(0, -1)}x`, KEY)).toBeUndefined()
		expect(verifyShareOgId(ogId, "another-key")).toBeUndefined()
	})

	it("rejects malformed input rather than throwing", () => {
		expect(verifyShareOgId("", KEY)).toBeUndefined()
		expect(verifyShareOgId("no-separator", KEY)).toBeUndefined()
		expect(verifyShareOgId(".signature-only", KEY)).toBeUndefined()
		// A short signature must not reach `timingSafeEqual`, which throws on a
		// length mismatch.
		expect(verifyShareOgId(`${Buffer.from(SHARE_ID).toString("base64url")}.short`, KEY)).toBeUndefined()
	})
})

// Decoded, not cast: `AlertRuleId` is a UUID brand, so a placeholder like
// "rule_1" is not merely untyped here — it is not a valid id at all.
const ORG_ID = Schema.decodeUnknownSync(OrgId)("org_3Aui9f2b6a8e")
const RULE_ID = Schema.decodeUnknownSync(AlertRuleId)("1f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f")

const claims = {
	orgId: ORG_ID,
	ruleId: RULE_ID,
	groupKey: "checkout-api",
	fromMs: Date.UTC(2026, 7, 18, 13, 0),
	toMs: Date.UTC(2026, 7, 18, 14, 0),
	title: "Error Rate · checkout-api",
	unit: "percent",
	threshold: 2,
	breachSide: "above",
} as const

/** What `claims` looks like coming back out — ids undecoded, by design. */
const verified = {
	rawOrgId: ORG_ID as string,
	rawRuleId: RULE_ID as string,
	groupKey: claims.groupKey,
	fromMs: claims.fromMs,
	toMs: claims.toMs,
	title: claims.title,
	unit: claims.unit,
	threshold: claims.threshold,
	breachSide: claims.breachSide,
}

/**
 * Re-signs nothing: it swaps one claim inside an id and keeps the original
 * signature, which is exactly the forgery verification must refuse.
 */
const tamperClaim = (id: string, index: number, value: unknown): string => {
	// SAFETY: both minters emit exactly `<payload>.<signature>`.
	const [encoded, signature] = id.split(".") as [string, string]
	// SAFETY: the payload is the array the encoder just wrote.
	const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown[]
	claims[index] = value
	return `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`
}

const chatClaims = {
	orgId: ORG_ID,
	sessionId: `${ORG_ID}:tab-8f21`,
	messageId: "01JB8QK0Q9R5W0C4V8ZD2M6X7T",
	chartIndex: 1,
}

const verifiedChat = {
	rawOrgId: ORG_ID as string,
	rawSessionId: chatClaims.sessionId,
	rawMessageId: chatClaims.messageId,
	chartIndex: chatClaims.chartIndex,
}

/**
 * The two signed chart ids, which differ in their payload and in nothing else
 * that matters here: each is `<base64url claims>.<HMAC>` under its own
 * domain-separation label, and every property below is a property of that
 * construction rather than of either payload.
 */
const SIGNERS = [
	{
		name: "alertChartId",
		mint: (key: string) => alertChartId(claims, key),
		verify: verifyAlertChartId,
		expected: verified,
		/** A claim whose forgery is worth naming, and the position it sits at. */
		forgeries: [
			// The window is signed precisely so a holder of the URL cannot turn a
			// one-hour chart into a one-year warehouse scan.
			{ what: "a widened window", index: 3, value: 0 },
			// The threshold is signed, so a delivered alert's picture cannot be
			// re-pointed at a different line after the fact.
			{ what: "a lowered threshold", index: 7, value: 0.1 },
			{ what: "a rewritten title", index: 5, value: "Everything is fine" },
		],
	},
	{
		name: "chatChartId",
		mint: (key: string) => chatChartId(chatClaims, key),
		verify: verifyChatChartId,
		expected: verifiedChat,
		forgeries: [
			{ what: "a swapped conversation", index: 1, value: "org_other:tab-8f21" },
			{ what: "a swapped message", index: 2, value: "some-other-message" },
			{ what: "a walked chart index", index: 3, value: 4 },
		],
	},
] as const

describe.each(SIGNERS)("$name", ({ mint, verify, expected, forgeries }) => {
	it("round-trips the claims, with the ids left undecoded", () => {
		// The signature proves we minted it; it does not decode an entity id, so
		// they come back as `raw*` for the caller to parse at its boundary.
		expect(verify(mint(KEY), KEY)).toEqual(expected)
	})

	it("is deterministic, so one notification keeps one image URL", () => {
		expect(mint(KEY)).toBe(mint(KEY))
	})

	it("rejects an id minted under a different key", () => {
		expect(verify(mint("other-key"), KEY)).toBeUndefined()
	})

	// A loop rather than `it.each`: the table is `as const`, so its rows arrive
	// as a readonly tuple and `it.each` resolves to its spread-the-tuple overload.
	for (const { what, index, value } of forgeries) {
		it(`rejects ${what}`, () => {
			expect(verify(tamperClaim(mint(KEY), index, value), KEY)).toBeUndefined()
		})
	}

	it("rejects malformed ids without throwing", () => {
		for (const bad of ["", ".", "nodot", ".onlysig", "a.b", "!!!.???"]) {
			expect(verify(bad, KEY)).toBeUndefined()
		}
	})

	it("does not accept a share OG id, and is not accepted as one", () => {
		// Distinct domain-separation labels: a signature minted to render a
		// dashboard preview must not render a chart, or the reverse.
		expect(verify(shareOgId("share_1", KEY), KEY)).toBeUndefined()
		expect(verifyShareOgId(mint(KEY), KEY)).toBeUndefined()
	})
})

describe("the two chart ids, against each other", () => {
	it("refuses the other's signature, so one cannot be replayed as the other", () => {
		expect(verifyChatChartId(alertChartId(claims, KEY), KEY)).toBeUndefined()
		expect(verifyAlertChartId(chatChartId(chatClaims, KEY), KEY)).toBeUndefined()
	})
})

describe("alertChartId, on claims only it carries", () => {
	it("round-trips an ungrouped rule's null group", () => {
		const ungrouped = { ...claims, groupKey: null }
		expect(verifyAlertChartId(alertChartId(ungrouped, KEY), KEY)).toEqual({
			...verified,
			groupKey: null,
		})
	})

	it("rejects a swapped rule id", () => {
		const id = alertChartId(claims, KEY)
		const other = alertChartId(
			{
				...claims,
				ruleId: Schema.decodeUnknownSync(AlertRuleId)("2f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f"),
			},
			KEY,
		)
		const forged = `${id.split(".")[0]}.${other.split(".")[1]}`
		expect(verifyAlertChartId(forged, KEY)).toBeUndefined()
	})
})

describe("chatChartId, on claims only it carries", () => {
	it("refuses a signed index that is not a whole count", () => {
		// Reached only for a payload this repo signed, and it is still decoded:
		// the position is an array index, and -1 or 1.5 is not one.
		for (const index of [-1, 1.5]) {
			const id = chatChartId({ ...chatClaims, chartIndex: index }, KEY)
			expect(verifyChatChartId(id, KEY)).toBeUndefined()
		}
	})
})
