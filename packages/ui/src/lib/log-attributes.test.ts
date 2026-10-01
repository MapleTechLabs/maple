import { describe, expect, it } from "vitest"
import { getChipTone, pickImportantAttributes } from "./log-attributes"

describe("getChipTone for rpc.response.status_code", () => {
	it("marks the gRPC codes semconv treats as server errors", () => {
		expect(getChipTone("rpc.response.status_code", "UNAVAILABLE", "INFO", "grpc")).toBe("error")
		expect(getChipTone("rpc.response.status_code", "internal", "INFO", "grpc")).toBe("error")
		expect(getChipTone("rpc.response.status_code", "14", "INFO", "grpc")).toBe("error")
	})

	it("warns on other non-OK gRPC codes and leaves OK alone", () => {
		expect(getChipTone("rpc.response.status_code", "NOT_FOUND", "INFO", "grpc")).toBe("warn")
		expect(getChipTone("rpc.response.status_code", "OK", "INFO", "grpc")).toBe("muted")
		expect(getChipTone("rpc.response.status_code", "0", "INFO", "grpc")).toBe("muted")
	})

	it("keeps values from other or unknown rpc systems neutral", () => {
		expect(getChipTone("rpc.response.status_code", "-32601", "INFO", "grpc")).toBe("muted")
		expect(getChipTone("rpc.response.status_code", "INTERNAL", "INFO", "jsonrpc")).toBe("muted")
		expect(getChipTone("rpc.response.status_code", "2", "INFO")).toBe("muted")
	})

	it("reads the rpc system from the row for the inline chips", () => {
		const log = {
			logAttributes: { "rpc.system.name": "grpc", "rpc.response.status_code": "UNAVAILABLE" },
			resourceAttributes: {},
			serviceName: "api",
			severityText: "INFO",
		}
		const status = pickImportantAttributes(log).find((a) => a.key === "rpc.response.status_code")
		expect(status?.tone).toBe("error")
	})
})
