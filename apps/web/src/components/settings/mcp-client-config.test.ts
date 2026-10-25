import { describe, expect, it } from "vitest"
import { claudeCodeCommand, mcpClientConfig } from "./mcp-client-config"

const endpoint = "https://api.maple.dev/mcp"

describe("mcpClientConfig", () => {
	it("gives each client the URL under the key it reads", () => {
		expect(JSON.parse(mcpClientConfig("claude-code", endpoint)).mcpServers.maple).toEqual({
			type: "http",
			url: endpoint,
		})
		expect(JSON.parse(mcpClientConfig("cursor", endpoint)).mcpServers.maple).toEqual({ url: endpoint })
		expect(JSON.parse(mcpClientConfig("windsurf", endpoint)).mcpServers.maple).toEqual({
			serverUrl: endpoint,
		})
	})

	it("adds a bearer header only when an MCP key exists", () => {
		const withKey = JSON.parse(mcpClientConfig("windsurf", endpoint, "maple_ak_secret"))
		expect(withKey.mcpServers.maple.headers).toEqual({ Authorization: "Bearer maple_ak_secret" })
		expect(JSON.parse(mcpClientConfig("other", endpoint)).mcpServers.maple.headers).toBeUndefined()
	})
})

describe("claudeCodeCommand", () => {
	it("adds the header flag only for a key", () => {
		expect(claudeCodeCommand(endpoint)).toBe(`claude mcp add --transport http maple ${endpoint}`)
		expect(claudeCodeCommand(endpoint, "k")).toContain('--header "Authorization: Bearer k"')
	})
})
