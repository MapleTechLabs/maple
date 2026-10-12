import { describe, expect, it } from "vitest"
import { CHAT_ANTICIPATED_ERROR_IDENTIFIERS } from "../../anticipated"

// The tag `outbound.ts` retries on. Renaming it without this list would bring back an exception
// event on every rate-limited attempt.
describe("anticipated errors", () => {
	it("covers the slack rate-limit retry signal", () => {
		expect(CHAT_ANTICIPATED_ERROR_IDENTIFIERS).toContain(
			"@maple/chat-platform/connectors/slack/RateLimited",
		)
	})
})
