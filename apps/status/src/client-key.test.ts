import { describe, expect, it } from "vitest"
import { clientRateLimitKey } from "./client-key"

describe("clientRateLimitKey", () => {
	it("keeps an IPv4 address whole", () => {
		expect(clientRateLimitKey("203.0.113.7")).toBe("203.0.113.7")
		expect(clientRateLimitKey("203.0.113.8")).not.toBe(clientRateLimitKey("203.0.113.7"))
	})

	it("gives every address of one IPv6 /64 the same key", () => {
		const key = clientRateLimitKey("2001:db8:12:3400::1")
		expect(key).toBe("2001:db8:12:3400::/64")
		expect(clientRateLimitKey("2001:db8:12:3400:ffff:ffff:ffff:ffff")).toBe(key)
		expect(clientRateLimitKey("2001:0DB8:0012:3400:a:b:c:d")).toBe(key)
		expect(clientRateLimitKey("2001:db8:12:3400:1:2::")).toBe(key)
	})

	it("tells neighbouring /64s apart", () => {
		expect(clientRateLimitKey("2001:db8:12:3401::1")).toBe("2001:db8:12:3401::/64")
		expect(clientRateLimitKey("2001:db8:12::1")).toBe("2001:db8:12:0::/64")
		expect(clientRateLimitKey("::1")).toBe("0:0:0:0::/64")
	})

	it("expands a compressed address before taking the prefix", () => {
		expect(clientRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64")
		expect(clientRateLimitKey("2001:db8::7:8:9:a:b")).toBe("2001:db8:0:7::/64")
		expect(clientRateLimitKey("fe80::1:2:3:4")).toBe("fe80:0:0:0::/64")
	})

	it("keys an IPv4 client that arrives mapped into IPv6 by its IPv4 address", () => {
		expect(clientRateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7")
		expect(clientRateLimitKey("::ffff:cb00:7107")).toBe("203.0.113.7")
		expect(clientRateLimitKey("0:0:0:0:0:ffff:203.0.113.8")).toBe("203.0.113.8")
	})

	it("falls back to the value as it came when it does not parse", () => {
		for (const raw of [
			"unknown",
			"",
			"2001:db8:::1",
			"2001:db8::1::2",
			"2001:db8:12:3400:1:2:3",
			"2001:db8:12:3400:1:2:3:4:5",
			"1:2:3:4:5:6:7::8",
			"2001:db8:zz::1",
			"2001:db8:12345::1",
			"::ffff:203.0.113.999",
			"2001:db8:203.0.113.7::1",
		]) {
			expect(clientRateLimitKey(raw), raw).toBe(raw)
		}
	})
})
