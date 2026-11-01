import { describe, expect, it } from "vitest"
import { mcpClientOf } from "./mcp-clients"

describe("mcpClientOf", () => {
	it("groups every version of a client into one family", () => {
		expect(mcpClientOf("claude-code/2.1.314 (sdk-ts, agent-sdk/0.3.280)")).toEqual({
			name: "Claude Code",
			kind: "agent",
		})
		expect(mcpClientOf("claude-code/2.1.316 (cli)")).toEqual(mcpClientOf("claude-code/2.1.299 (sdk-cli)"))
	})

	it("tells agents from scripts and the org's own callers", () => {
		expect(mcpClientOf("openai-mcp/1.0.0 (Codex)").kind).toBe("agent")
		expect(mcpClientOf("curl/8.18.0")).toEqual({ name: "curl", kind: "script" })
		expect(mcpClientOf("undici").name).toBe("Node (undici)")
		expect(mcpClientOf("executor").kind).toBe("internal")
	})

	it("names an unrecognised client by its product token", () => {
		expect(mcpClientOf("estate-mcp/3.1 (linux)")).toEqual({ name: "estate-mcp", kind: "unknown" })
	})

	it("files a call without a user agent under unknown", () => {
		expect(mcpClientOf("  ")).toEqual({ name: "unknown", kind: "unknown" })
	})
})
