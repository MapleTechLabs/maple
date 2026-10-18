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

/** `toBase64Url(JSON.stringify(ctx))`, the encoding alert links and the widget menu write. */
const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

/** An alert notification's "Investigate in chat" link (`?mode=alert`). */
const ALERT_PATH = `/chat?mode=alert&alert=${base64Url({
	ruleId: "rule_parity_checkout_p95",
	ruleName: "Checkout p95 latency over budget",
	incidentId: "0199b0aa-0000-7000-8000-00000000a1e7",
	eventType: "trigger",
	signalType: "p95_latency",
	severity: "critical",
	comparator: "gt",
	threshold: 800,
	value: 1840,
	windowMinutes: 5,
	groupKey: "checkout-api",
	sampleCount: 120,
})}`

/** A broken widget's "Fix with AI" (`?mode=widget-fix`). */
const WIDGET_FIX_PATH = `/chat?mode=widget-fix&widget=${base64Url({
	dashboardId: "0199c0de-0000-7000-8000-0000000d45b0",
	widgetId: "w-checkout-p95",
	widgetTitle: "Checkout p95 latency",
	widgetJson: JSON.stringify({ id: "w-checkout-p95", visualization: "chart", dataSource: { endpoint: "custom_timeseries" } }),
	errorTitle: "Invalid widget config",
	errorMessage: "dataSource.params is missing: a custom timeseries needs a metric and an aggregation.",
})}`

const subjectScenarios: ReadonlyArray<Scenario> = [
	{ ...scenario("alert", "an alert attached from its notification", "default"), path: ALERT_PATH },
	{
		...scenario("alert-send", "an alert suggestion sent with its context", "default", async (page) => {
			await page.getByRole("button", { name: "Slowest operations in checkout-api right now" }).click()
			await replied(page)
		}),
		path: ALERT_PATH,
	},
	{
		...scenario("alert-typed", "a typed question about the attached alert", "default", async (page) => {
			await page.getByPlaceholder("Ask about this alert…").fill("Is this the deploy?")
			await page.getByPlaceholder("Ask about this alert…").press("Enter")
			await replied(page)
		}),
		path: ALERT_PATH,
	},
	{ ...scenario("widget-fix", "a broken widget's fix prompt sent on arrival", "default", replied), path: WIDGET_FIX_PATH },
]

/**
 * Page context: the sheet opened over `/traces` (the root records it as `maple-chat-referrer`) shows
 * a "Traces explorer" chip and route-aware suggestions, sends the context block with the first
 * message unless the chip was removed, and hands both to `/chat` through Open full page.
 */
const overTraces = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	...scenario(`context-${id}`, `page context, ${title}`, "default", async (page) => {
		await openSheet(page)
		await page.getByRole("dialog").getByRole("button", { name: "Remove Traces explorer" }).waitFor()
		await steps(page)
	}),
	path: "/traces",
})

const contextScenarios: ReadonlyArray<Scenario> = [
	overTraces("sheet", "the sheet opened over the traces explorer", async () => {}),
	overTraces("sheet-send", "a route-aware suggestion sent with the context", async (page) => {
		await page.getByRole("dialog").getByRole("button", { name: "Find traces with errors" }).click()
		await replied(page)
	}),
	overTraces("sheet-dismissed", "the chip removed, then a question sent without it", async (page) => {
		await page.getByRole("dialog").getByRole("button", { name: "Remove Traces explorer" }).click()
		await page.getByRole("dialog").getByRole("button", { name: "Remove Traces explorer" }).waitFor({ state: "detached" })
		await page.getByRole("dialog").getByRole("button", { name: "Show me the slowest traces" }).click()
		await replied(page)
	}),
	overTraces("full-page", "carried to the full page", async (page) => {
		await page.getByRole("dialog").getByRole("link", { name: "Open full page" }).click()
		await page.getByRole("button", { name: "Remove Traces explorer" }).waitFor()
	}),
]

/** The mermaid block's toolbar on `chat-code`: the download menu, fullscreen, and pan and zoom. */
const diagram = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario =>
	scenario(`code-${id}`, `the mermaid diagram, ${title}`, "chat-code", async (page) => {
		await page.getByRole("button", { name: "Copy Code" }).first().waitFor()
		await steps(page)
	})

const openFullscreen = async (page: Page) => {
	await page.getByRole("button", { name: "View fullscreen" }).click()
	await page.getByRole("dialog", { name: "View fullscreen" }).getByRole("img", { name: "Mermaid chart" }).waitFor()
}

const diagramScenarios: ReadonlyArray<Scenario> = [
	diagram("download-menu", "its download menu open", (page) =>
		page.getByRole("button", { name: "Download diagram", exact: true }).click(),
	),
	diagram("download-mmd", "its source downloaded as MMD", async (page) => {
		await page.getByRole("button", { name: "Download diagram", exact: true }).click()
		await page.getByRole("button", { name: "Download diagram as MMD" }).click()
		await page.getByRole("button", { name: "Download diagram as MMD" }).waitFor({ state: "detached" })
	}),
	diagram("download-menu-dismissed", "its download menu closed by a press outside", async (page) => {
		await page.getByRole("button", { name: "Download diagram", exact: true }).click()
		await page.getByText("The slow authorizations all run this query:").click()
		await page.getByRole("button", { name: "Download diagram as SVG" }).waitFor({ state: "detached" })
	}),
	diagram("zoom", "zoomed in twice", async (page) => {
		await page.getByRole("button", { name: "Zoom in" }).click()
		await page.getByRole("button", { name: "Zoom in" }).click()
	}),
	diagram("zoom-reset", "zoomed out and reset", async (page) => {
		await page.getByRole("button", { name: "Zoom out" }).click()
		await page.getByRole("button", { name: "Reset zoom and pan" }).click()
	}),
	diagram("fullscreen", "opened fullscreen", openFullscreen),
	diagram("fullscreen-menu", "its fullscreen download menu open", async (page) => {
		await openFullscreen(page)
		await page.getByRole("dialog").getByRole("button", { name: "Download diagram", exact: true }).click()
	}),
	diagram("fullscreen-exit", "fullscreen closed with its exit button", async (page) => {
		await openFullscreen(page)
		await page.getByRole("button", { name: "Exit fullscreen" }).click()
		await page.getByRole("dialog").waitFor({ state: "detached" })
	}),
	diagram("fullscreen-escape", "fullscreen closed with Escape", async (page) => {
		await openFullscreen(page)
		await page.keyboard.press("Escape")
		await page.getByRole("dialog").waitFor({ state: "detached" })
	}),
]

/** `?m=` permalinks open the transcript on their message; the link itself is copied from the row. */
const permalinkScenarios: ReadonlyArray<Scenario> = [
	{
		...scenario("permalink", "a message permalink opened on its own conversation", "chat-conversation"),
		path: "/chat?tab=default&m=msg_parity_assistant_1",
	},
	{
		...scenario("shared-permalink", "a shared conversation opened on one message", "chat-conversation"),
		path: "/chat?shared=default&title=Checkout%20incident&m=msg_parity_assistant_1",
	},
	scenario("copy-permalink", "a message's permalink copied", "chat-conversation", async (page) => {
		await page.getByText("payment-svc 3.5.0 is exhausting its Postgres connection pool.").hover()
		await page.getByRole("button", { name: "Copy Link to message" }).first().click()
	}),
]

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
	sheet("full-page", "its thread opened in the full page", async (page) => {
		await openSheet(page)
		await page.getByRole("dialog").getByRole("link", { name: "Open full page" }).click()
		await page.getByRole("complementary", { name: "Chat conversations" }).getByText("Quick chat").waitFor()
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
		scenario("code", "a reply with a SQL block and a mermaid diagram", "chat-code", async (page) => {
			await page.getByRole("button", { name: "Copy Code" }).first().waitFor()
		}),
		scenario("math", "a reply with text math, a math block and a math fence", "chat-math", async (page) => {
			await page.getByText("With the window at one hour:").waitFor()
		}),
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
		...subjectScenarios,
		...permalinkScenarios,
		...diagramScenarios,
		...contextScenarios,
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
