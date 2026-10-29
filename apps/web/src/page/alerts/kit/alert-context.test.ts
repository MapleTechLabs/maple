import { describe, expect, test } from "vitest"
import { decodeAlertContextFromSearchParam } from "./alert-context"

// The backend's `toBase64Url` (AlertDeliveryDispatch.ts): UTF-8 base64 made URL-safe, padding stripped.
const backendParam = (payload: Record<string, unknown>): string =>
	Buffer.from(JSON.stringify(payload), "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")

describe("decodeAlertContextFromSearchParam", () => {
	test("reads the rule id from the payload the backend's View alert link carries", () => {
		const param = backendParam({
			ruleId: "rule_9f?>",
			ruleName: "Läuft zu langsam: 漢字 🚀",
			incidentId: null,
			eventType: "trigger",
			threshold: 0.5,
		})
		expect(param).not.toContain("=")
		expect(decodeAlertContextFromSearchParam(param)?.ruleId).toBe("rule_9f?>")
	})

	test("a param that is not base64url JSON with a rule id reads as absent", () => {
		expect(decodeAlertContextFromSearchParam("%%%not-base64")).toBeUndefined()
		expect(decodeAlertContextFromSearchParam(backendParam({ ruleName: "no id" }))).toBeUndefined()
		expect(
			decodeAlertContextFromSearchParam(Buffer.from("not json").toString("base64url")),
		).toBeUndefined()
	})
})
