import { describe, expect, it } from "vitest"
import { sessionUserHref } from "./view-session"

describe("the replay's user link", () => {
	it("opens the user page over a day either side of the session", () => {
		expect(
			sessionUserHref("user/42", {
				startTime: "2026-10-01 11:18:00",
				lastActivityAt: "2026-10-01 11:40:00",
			}),
		).toBe("/users/user%2F42?startTime=2026-09-30+11%3A18%3A00&endTime=2026-10-02+11%3A40%3A00")
	})
})
