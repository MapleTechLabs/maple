import { describe, expect, it } from "vitest"
import app from "./app.ts"

const AGENT_URL = "https://chat.example/agents/maple-chat/org_1:default?offset=-1"
const ORIGIN = "https://app.maple.dev"

// Minimal env — these tests only exercise CORS + the deny-by-default auth gate,
// neither of which reads worker bindings.
const env = {} as never

describe("chat-flue CORS", () => {
	it("answers the /agents preflight without auth (before the 401 gate)", async () => {
		const res = await app.fetch(
			new Request(AGENT_URL, {
				method: "OPTIONS",
				headers: {
					Origin: ORIGIN,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "authorization",
				},
			}),
			env,
		)

		expect(res.status).toBe(204)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
		// Hono reflects the requested headers, so Authorization is allowed.
		expect((res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase()).toContain(
			"authorization",
		)
		// The Durable-Streams offset header must be readable by the browser.
		expect(res.headers.get("Access-Control-Expose-Headers") ?? "").toContain("Stream-Next-Offset")
	})

	it("keeps CORS headers on the 401 so the browser can read the rejection", async () => {
		const res = await app.fetch(
			new Request(AGENT_URL, { method: "GET", headers: { Origin: ORIGIN } }),
			env,
		)

		expect(res.status).toBe(401)
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
	})
})
