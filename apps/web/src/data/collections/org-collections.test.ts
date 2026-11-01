import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Context, Effect, Option } from "effect"
import { SessionBearer } from "../../platform/session-bearer"
import { makeSyncFetch } from "./org-collections"

const bearer = Context.make(SessionBearer, {
	token: Effect.succeed(Option.some("session-token")),
	freshToken: Effect.succeed(Option.some("session-token")),
})

const alertRulesUrl = "https://sync.example.com/api/sync/shape?shape=alert_rules"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("makeSyncFetch", () => {
	it("sends the shape request with the session bearer while sync is on", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }))
		const response = await makeSyncFetch(bearer, true)(alertRulesUrl)
		expect(response.status).toBe(200)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
			"Bearer session-token",
		)
	})

	it("answers 503 without a request on a deploy with no Electric", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		const response = await makeSyncFetch(bearer, false)(alertRulesUrl)
		expect(response.status).toBe(503)
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
