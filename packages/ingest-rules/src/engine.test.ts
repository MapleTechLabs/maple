import { describe, expect, it } from "@effect/vitest"
import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { Schema } from "effect"
import { applyRules, compileRules, globMatches, type RuleRecord } from "./engine"
import { hmacSha256, sha256, toHex, utf8 } from "./sha256"

const maskEverything: IngestRuleSpec = {
	signals: ["logs"],
	conditions: [],
	action: {
		_tag: "redact",
		keys: ["*secret*"],
		detectors: ["email", "credit_card", "jwt", "api_token", "ipv4", "ipv6", "phone", "iban"],
		patterns: ["ORD-[0-9]+"],
		scopes: ["attributes", "body"],
		method: "mask",
	},
}
const compiled = compileRules([maskEverything], "salt")
const logRecord = (attributes: Record<string, string>, body: string): RuleRecord => ({
	signal: "logs",
	resource: { "service.name": "api" },
	attributes,
	body,
})
const keptRecord = (record: RuleRecord): RuleRecord => {
	const outcome = applyRules(compiled, record)
	expect(outcome._tag).toBe("kept")
	return outcome._tag === "kept" ? outcome.record : record
}
const Attributes = Schema.Record(Schema.String, Schema.String)

describe("sha256", () => {
	it("matches the FIPS 180-2 vectors", () => {
		expect(toHex(sha256(utf8("")))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		)
		expect(toHex(sha256(utf8("abc")))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		)
		expect(toHex(sha256(utf8("a".repeat(1000))))).toBe(
			"41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
		)
	})

	it("matches RFC 4231 HMAC test case 2", () => {
		expect(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
			"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
		)
	})
})

describe("globMatches", () => {
	it("matches case-insensitively with stars anywhere", () => {
		expect(globMatches("*password*", "DB_PASSWORD_HASH")).toBe(true)
		expect(globMatches("http.request.header.*", "http.request.header.authorization")).toBe(true)
		expect(globMatches("a*b*c", "axxbyyc")).toBe(true)
		expect(globMatches("a*b*c", "axxbyy")).toBe(false)
		expect(globMatches("user.id", "user.ids")).toBe(false)
	})
})

describe("applyRules properties", () => {
	it.prop(
		"masking twice changes nothing more than masking once",
		[Attributes, Schema.String],
		([attributes, body]) => {
			const once = keptRecord(logRecord(attributes, body))
			const twice = keptRecord(once)
			expect(twice.attributes).toEqual(once.attributes)
			expect(twice.body).toEqual(once.body)
		},
	)

	it.prop(
		"text with no digits, capitals, @, :, _ or - and no secret keys is untouched",
		[Attributes],
		([attributes]) => {
			const clean = Object.fromEntries(
				Object.entries(attributes)
					.filter(([key]) => !key.toLowerCase().includes("secret"))
					.map(([key, value]) => [key, value.replace(/[0-9@A-Z:_-]/g, "x")]),
			)
			expect(keptRecord(logRecord(clean, "plain words only")).attributes).toEqual(clean)
		},
	)
})
