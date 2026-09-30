import { describe, expect, it } from "vitest"
import { getChipTone } from "./log-attributes"

describe("getChipTone for rpc.response.status_code", () => {
	it("marks the gRPC codes semconv treats as server errors", () => {
		expect(getChipTone("rpc.response.status_code", "UNAVAILABLE", "INFO")).toBe("error")
		expect(getChipTone("rpc.response.status_code", "internal", "INFO")).toBe("error")
		expect(getChipTone("rpc.response.status_code", "14", "INFO")).toBe("error")
	})

	it("warns on other non-OK gRPC codes and leaves OK alone", () => {
		expect(getChipTone("rpc.response.status_code", "NOT_FOUND", "INFO")).toBe("warn")
		expect(getChipTone("rpc.response.status_code", "OK", "INFO")).toBe("muted")
		expect(getChipTone("rpc.response.status_code", "0", "INFO")).toBe("muted")
	})

	it("keeps values from other rpc systems neutral", () => {
		expect(getChipTone("rpc.response.status_code", "-32601", "INFO")).toBe("muted")
	})
})
