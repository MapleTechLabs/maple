import { describe, expect, it } from "vitest"
import { decodeLogKey, encodeLogKey } from "./log-key"

describe("log-key", () => {
	// The key carries the stored nanosecond literal, which the log lookup matches exactly.
	it("round-trips a log with full trace context", () => {
		const log = {
			exactTimestamp: "2026-05-19 12:54:36.123456",
			serviceName: "checkout-api",
			traceId: "abcdef0123456789abcdef0123456789",
			spanId: "0123456789abcdef",
		}
		const { exactTimestamp, ...rest } = log
		expect(decodeLogKey(encodeLogKey(log))).toEqual({ timestamp: exactTimestamp, ...rest })
	})

	it("round-trips a log without trace/span context", () => {
		const log = {
			exactTimestamp: "2026-05-19 12:54:36",
			serviceName: "worker",
			traceId: "",
			spanId: "",
		}
		const { exactTimestamp, ...rest } = log
		expect(decodeLogKey(encodeLogKey(log))).toEqual({ timestamp: exactTimestamp, ...rest })
	})

	it("preserves non-ASCII service names", () => {
		const log = {
			exactTimestamp: "2026-05-19 00:00:00",
			serviceName: "café-service-日本",
			traceId: "",
			spanId: "",
		}
		const { exactTimestamp, ...rest } = log
		expect(decodeLogKey(encodeLogKey(log))).toEqual({ timestamp: exactTimestamp, ...rest })
	})

	it("produces URL-safe tokens (no +, /, or = padding)", () => {
		const token = encodeLogKey({
			exactTimestamp: "2026-05-19 12:54:36.999999",
			serviceName: "svc/with+chars",
			traceId: "ff".repeat(16),
			spanId: "ee".repeat(8),
		})
		expect(token).not.toMatch(/[+/=]/)
	})

	it("returns null for malformed tokens", () => {
		expect(decodeLogKey("@@@")).toBeNull()
		expect(decodeLogKey("")).toBeNull()
		expect(decodeLogKey("bm90LWpzb24")).toBeNull() // base64url of "not-json"
	})

	it("returns null when the decoded payload has the wrong shape", () => {
		const validToken = encodeLogKey({
			exactTimestamp: "2026-05-19 00:00:00",
			serviceName: "svc",
			traceId: "",
			spanId: "",
		})
		// sanity: the valid token decodes
		expect(decodeLogKey(validToken)).not.toBeNull()
		// a token whose payload is a 2-tuple is rejected
		const shortTuple = Buffer.from(JSON.stringify(["a", "b"]))
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "")
		expect(decodeLogKey(shortTuple)).toBeNull()
	})

	it("returns null when timestamp or serviceName is empty", () => {
		const emptyTs = encodeLogKey({ exactTimestamp: "", serviceName: "svc", traceId: "", spanId: "" })
		expect(decodeLogKey(emptyTs)).toBeNull()
	})
})
