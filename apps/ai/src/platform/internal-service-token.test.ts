import { describe, expect, it } from "vitest"
import { Option, Redacted } from "effect"
import { checkInternalServiceToken } from "./internal-service-token"

const configured = Option.some(Redacted.make("s3cret"))

describe("checkInternalServiceToken", () => {
	it("accepts the configured token behind the service prefix", () => {
		expect(checkInternalServiceToken("maple_svc_s3cret", configured)).toBe("accepted")
	})

	it("rejects another token, or the right one without the prefix", () => {
		expect(checkInternalServiceToken("maple_svc_other", configured)).toBe("rejected")
		expect(checkInternalServiceToken("s3cret", configured)).toBe("rejected")
		expect(checkInternalServiceToken("", configured)).toBe("rejected")
	})

	it("treats a blank configured token as none, so a bare prefix never matches it", () => {
		expect(checkInternalServiceToken("maple_svc_", Option.some(Redacted.make("")))).toBe("unconfigured")
		expect(checkInternalServiceToken("maple_svc_s3cret", Option.none())).toBe("unconfigured")
	})
})
