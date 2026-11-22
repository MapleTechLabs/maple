import { describe, expect, it } from "vitest"
import { clientMarkOf } from "./view-kit"

const iconOf = (name: string) => clientMarkOf(name).icon

describe("clientMarkOf", () => {
	it("matches a client family by the name's first word", () => {
		expect(iconOf("Claude Code")).toBe("ClaudeIcon")
		expect(iconOf("codex-mcp-client")).toBe("OpenAiIcon")
		expect(iconOf("Python-urllib")).toBe("PythonIcon")
		expect(iconOf("Python (httpx)")).toBe("PythonIcon")
		expect(iconOf("Node (undici)")).toBe("NodejsIcon")
		expect(iconOf("VS Code")).toBe("VsCodeIcon")
	})

	it("does not match a family on a prefix inside a longer word", () => {
		expect(iconOf("google-gemini")).toBe("GlobeIcon")
		expect(iconOf("cursorless")).toBe("GlobeIcon")
	})

	it("gives Maple's own callers the Maple mark", () => {
		expect(iconOf("executor")).toBe("MapleMark")
		expect(iconOf("estate-console")).toBe("MapleMark")
	})

	it("falls back to a muted globe for an unknown client", () => {
		expect(clientMarkOf("deploy-check")).toEqual({
			icon: "GlobeIcon",
			className: "text-muted-foreground",
		})
	})
})
