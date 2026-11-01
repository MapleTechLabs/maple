import { describe, expect, it } from "vitest"
import { coverageRows, failureKinds } from "./data-map"

const coverage = {
	toolCalls: 100,
	withToolName: 100,
	withUserAgent: 90,
	toolErrors: 4,
	errorsWithMessage: 0,
	withSession: 0,
	withCallerTrace: 1,
	protocolVersion: "2025-06-18",
	transport: "tcp",
}

describe("coverageRows", () => {
	const row = (label: string) => coverageRows(coverage).find((entry) => entry.label === label)

	it("marks an attribute present only when every call carries it", () => {
		expect(row("Method and tool")?.isPresent).toBe(true)
		expect(row("Client per call")?.isPresent).toBe(false)
		expect(row("Client per call")?.detail).toContain("On 90 of 100 tool calls.")
	})

	it("counts the calls that joined a caller's trace", () => {
		expect(row("Caller's trace")).toMatchObject({
			isPresent: true,
			detail: "1 of 100 calls join an agent's trace.",
		})
	})

	it("says failures can't be grouped when no failed call carries a message", () => {
		expect(row("Why a tool failed")?.isPresent).toBe(false)
	})
})

describe("failureKinds", () => {
	it("splits tool errors from JSON-RPC codes and lists the codes seen", () => {
		const [tool, rpc] = failureKinds([
			{ errorType: "tool_error", count: 7 },
			{ errorType: "-32603", count: 2 },
		])
		expect(tool?.count).toBe(7)
		expect(rpc).toMatchObject({ codes: ["-32603"], count: 2 })
	})
})
