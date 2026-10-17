import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** `/chat`: a new conversation on `default`, and a finished incident investigation on `chat-conversation`. */
const scenario = (
	id: string,
	title: string,
	dataset: string,
	steps?: (page: Page) => Promise<void>,
): Scenario => ({
	id: `chat-${id}`,
	title: `Chat: ${title}`,
	path: "/chat",
	dataset,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...(steps === undefined ? undefined : { steps }),
	area: "chat",
})

export const chatArea: AreaModule = {
	area: "chat",
	scenarios: [
		scenario("empty", "New conversation", "default"),
		scenario("conversation", "Incident investigation", "chat-conversation"),
		scenario(
			"conversation-tool-open",
			"Incident investigation, a tool call expanded",
			"chat-conversation",
			(page) => page.getByRole("button", { name: /List Releases/ }).click(),
		),
	],
}
