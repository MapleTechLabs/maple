import { describe, expect, it } from "vitest"
import { clientInfoUnit, coverageRows, failureKinds, sessionsScreen } from "./data-map"

const coverage = {
	toolCalls: 100,
	withToolName: 100,
	withUserAgent: 90,
	toolErrors: 4,
	errorsWithMessage: 0,
	withSession: 0,
	withUser: 40,
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

	it("builds sessions from users when the server issues no session id", () => {
		expect(row("Sessions")).toMatchObject({
			isPresent: false,
			detail: "Not sent: sessions are built from each user's calls instead.",
		})
		expect(row("Users")).toMatchObject({ isPresent: true, detail: "On 40 of 100 tool calls." })
	})

	it("points a server with neither a session id nor a user at user.id, which stateless MCP keeps", () => {
		const rows = coverageRows({ ...coverage, withUser: 0 })
		expect(rows.find((entry) => entry.label === "Sessions")?.detail).toBe(
			"Only older, stateful servers have one: send user.id above for sessions.",
		)
		const labels = rows.map((entry) => entry.label)
		expect(labels.indexOf("Users")).toBeLessThan(labels.indexOf("Sessions"))
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

describe("clientInfoUnit", () => {
	it("counts handshakes only while every clientInfo came on initialize", () => {
		expect(clientInfoUnit([{ count: 3, connects: 3 }])).toBe("connect")
	})

	it("counts requests once any clientInfo came on a later request", () => {
		expect(
			clientInfoUnit([
				{ count: 3, connects: 3 },
				{ count: 6, connects: 1 },
			]),
		).toBe("request")
	})
})

describe("sessionsScreen", () => {
	const screen = (sessions: number, toolCalls: number, withSession: number, withUser = 0) =>
		sessionsScreen({ totals: { sessions }, toolCalls, withSession, withUser })

	it("lists sessions whose requests were only initialize and tools/list", () => {
		expect(screen(2, 0, 0)).toBe("list")
	})

	it("is quiet when the window holds no session and no tool call", () => {
		expect(screen(0, 0, 0)).toBe("quiet")
	})

	it("asks for instrumentation when tool calls carry no session id", () => {
		expect(screen(0, 12, 0)).toBe("noSessions")
	})

	it("lists when calls name their user, though none carries a session id", () => {
		expect(screen(0, 12, 0, 3)).toBe("list")
	})

	it("lists an empty match when calls carry sessions the filters hide", () => {
		expect(screen(0, 12, 5)).toBe("list")
	})
})
