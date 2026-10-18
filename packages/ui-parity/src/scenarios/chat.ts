import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * `/chat`: a new conversation on `default`, a finished incident investigation on
 * `chat-conversation`, and every control on the page clicked through. A send is answered by the
 * fixture's scripted turn (`fixtures/areas/chat.ts`), so the call log carries the posted text.
 * `lab-chat-*` drive `/lab/chat`.
 */
const scenario = (
	id: string,
	title: string,
	dataset: string,
	steps?: (page: Page) => Promise<void>,
	extra: Partial<Scenario> = {},
): Scenario => ({
	id: `chat-${id}`,
	title: `Chat: ${title}`,
	path: "/chat",
	dataset,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...(steps === undefined ? undefined : { steps }),
	...extra,
	area: "chat",
})

const lab = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `lab-chat-${id}`,
	title: `Lab: Chat transcript, ${title}`,
	path: "/lab/chat",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	area: "chat",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const conversations = (page: Page) => page.getByRole("complementary", { name: "Chat conversations" })
const composer = (page: Page) => page.getByPlaceholder("Ask about your system…")
/** The scripted reply's last line: the turn ended and the transcript settled. */
const replied = (page: Page) => page.getByText("No new error fingerprints since the 3.4.2 deploy.").waitFor()

const openTabMenu = async (page: Page, index = 0) => {
	// Exact: the row itself is a button whose name contains its actions trigger's.
	await page.getByRole("button", { name: "Actions for New Chat", exact: true }).nth(index).click()
	await page.getByRole("menuitem", { name: "Rename" }).waitFor()
}

const newTab = async (page: Page) => {
	await conversations(page).getByRole("button", { name: "New chat", exact: true }).click()
	await conversations(page).getByText("New Chat", { exact: true }).nth(1).waitFor()
}

/** The global chat sheet (`GlobalChatSheet`), opened over the Overview from the top bar or with `C`. */
const sheet = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	...scenario(`sheet-${id}`, `global sheet, ${title}`, "default", steps),
	path: "/",
})

const openSheet = async (page: Page) => {
	await page.getByRole("button", { name: "Ask Maple AI" }).click()
	await page.getByRole("dialog").getByText("Or just start typing.", { exact: false }).waitFor()
}

const sheetScenarios: ReadonlyArray<Scenario> = [
	sheet("open", "opened from the top bar", openSheet),
	sheet("shortcut", "opened with C", async (page) => {
		await page.getByRole("button", { name: "Ask Maple AI" }).waitFor()
		await page.keyboard.press("c")
		await page.getByRole("dialog").waitFor()
	}),
	sheet("send", "a suggestion sent and answered", async (page) => {
		await openSheet(page)
		await page.getByRole("dialog").getByRole("button", { name: "Show me the slowest traces" }).click()
		await replied(page)
	}),
	sheet("new-chat", "a new conversation started in the sheet", async (page) => {
		await openSheet(page)
		await page.getByRole("dialog").getByRole("button", { name: "New chat" }).click()
	}),
	sheet("closed", "opened and closed again", async (page) => {
		await openSheet(page)
		await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
		await page.getByRole("dialog").waitFor({ state: "detached" })
	}),
]

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
		scenario("conversation-group-open", "Incident investigation, the tool group expanded", "chat-conversation", async (page) => {
			await page.getByRole("button", { name: /Service Overview/ }).click()
			await page.getByText("service=payment-svc").first().waitFor()
		}),
		scenario("loading", "history still loading", "default", undefined, {
			faults: { delays: { "chat.history": HELD_MS } },
			settle: "held",
		}),
		scenario("history-error", "history failing", "default", undefined, {
			faults: {
				failures: {
					"chat.history": { status: 502, body: { message: "ui-parity: injected chat history failure" } },
				},
			},
		}),
		scenario("send-suggestion", "a suggestion sent and answered", "default", async (page) => {
			await page.getByRole("button", { name: "What's the overall system health?" }).click()
			await replied(page)
		}),
		scenario("send-typed", "a typed question submitted", "default", async (page) => {
			await composer(page).fill("How is checkout-api doing?")
			await page.getByRole("button", { name: "Submit" }).click()
			await replied(page)
		}),
		scenario("send-followup", "a follow-up sent with Enter", "chat-conversation", async (page) => {
			await composer(page).fill("And the checkout service?")
			await composer(page).press("Enter")
			await replied(page)
		}),
		scenario("type-anywhere", "a keystroke with nothing focused lands in the composer", "default", async (page) => {
			await page.keyboard.type("hi")
		}),
		scenario("new-tab", "a second conversation", "default", newTab),
		scenario("switch-tab", "back to the first conversation", "chat-conversation", async (page) => {
			await newTab(page)
			await conversations(page).getByText("New Chat", { exact: true }).first().click()
			await page.getByText("payment-svc 3.5.0 is exhausting its Postgres connection pool.").first().waitFor()
		}),
		scenario("tab-menu", "a conversation's actions menu", "default", (page) => openTabMenu(page)),
		scenario("rename", "renamed from the actions menu", "default", async (page) => {
			await openTabMenu(page)
			await page.getByRole("menuitem", { name: "Rename" }).click()
			await conversations(page).getByRole("textbox").fill("Checkout latency")
			await conversations(page).getByRole("textbox").press("Enter")
			await conversations(page).getByText("Checkout latency").waitFor()
		}),
		scenario("rename-dblclick", "rename started with a double click", "default", async (page) => {
			await conversations(page).getByText("New Chat", { exact: true }).dblclick()
			await conversations(page).getByRole("textbox").waitFor()
		}),
		scenario("copy-link", "a share link copied", "default", async (page) => {
			await openTabMenu(page)
			await page.getByRole("menuitem", { name: "Copy link" }).click()
			await page.getByText("Share link copied").waitFor()
		}),
		scenario("delete-dialog", "deleting a conversation asks first", "default", async (page) => {
			await newTab(page)
			await openTabMenu(page, 1)
			await page.getByRole("menuitem", { name: "Delete" }).click()
			await page.getByRole("alertdialog").waitFor()
		}),
		scenario("delete", "a conversation deleted", "default", async (page) => {
			await newTab(page)
			await openTabMenu(page, 1)
			await page.getByRole("menuitem", { name: "Delete" }).click()
			await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
			await page.getByRole("alertdialog").waitFor({ state: "detached" })
		}),
		scenario("copy-message", "an answer copied", "chat-conversation", async (page) => {
			await page.getByText("payment-svc 3.5.0 is exhausting its Postgres connection pool.").hover()
			await page.getByRole("button", { name: "Copy Message" }).click()
		}),
		{
			...scenario("shared", "a teammate's shared conversation", "chat-conversation"),
			path: "/chat?shared=default&title=Checkout%20incident",
		},
		...sheetScenarios,
		lab("sheet-width", "at the sheet width", (page) => page.getByRole("button", { name: "Sheet (620px)" }).click()),
		lab("narrow-width", "at the narrow width", (page) => page.getByRole("button", { name: "Narrow (420px)" }).click()),
		lab("streaming", "streaming", async (page) => {
			await page.getByRole("button", { name: "Idle" }).click()
			await page.getByRole("button", { name: "Streaming" }).waitFor()
		}),
		lab("approved", "a proposal approved", async (page) => {
			await page.getByRole("button", { name: "Approve" }).click()
			await page.getByText("Applied").waitFor()
		}),
		lab("denied", "a proposal denied", async (page) => {
			await page.getByRole("button", { name: "Deny" }).click()
			await page.getByText("Denied").waitFor()
		}),
		lab("raw-input", "a proposal's raw input shown", async (page) => {
			await page.getByRole("button", { name: "Show raw input" }).click()
			await page.getByRole("button", { name: "Hide raw input" }).waitFor()
		}),
		lab("chip-dismissed", "a context chip removed", async (page) => {
			await page.getByRole("button", { name: "Remove Service: checkout-api-eu-west" }).click()
		}),
		lab("tool-open", "a standalone tool call expanded", async (page) => {
			await page.getByRole("button", { name: /Inspect Trace/ }).click()
			await page.getByText("Result").first().waitFor()
		}),
		lab("group-open", "a tool burst expanded", async (page) => {
			await page.getByRole("button", { name: /List Services/ }).click()
			await page.getByText("service=web-paywall-worker").first().waitFor()
		}),
	],
}
