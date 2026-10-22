import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import {
	expect as expectView,
	given,
	Mount,
	placeholder,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../../../route"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message as ConversationMessage } from "../conversation/message"
import { Message } from "./message"
import { MountMessage, MountStopClickPropagation } from "./mounts"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

// `?mode=alert` and `?mode=widget-fix`: the subject's own tab, its card, suggestions and preamble.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
const step = (model: Model, message: Message) => update(model, message, context)

const ALERT = base64Url({
	ruleId: "rule_1",
	ruleName: "Checkout p95 latency over budget",
	incidentId: "inc-0000-a1e7",
	eventType: "trigger",
	signalType: "p95_latency",
	severity: "critical",
	comparator: "gt",
	threshold: 800,
	value: 1840,
	windowMinutes: 5,
	groupKey: "checkout-api",
	sampleCount: 120,
})
const WIDGET = base64Url({
	dashboardId: "dash-1",
	widgetId: "w-1",
	widgetTitle: "Checkout p95",
	widgetJson: "{}",
	errorTitle: "Invalid widget config",
	errorMessage: null,
})

const entered = (search: Record<string, string>) =>
	step(
		init(AppRoute.Chat({ search }), context).model,
		Message.CompletedLoadTabs({
			state: {
				tabs: [{ id: "default", title: "New Chat", createdAt: NOW, updatedAt: NOW }],
				activeTabId: "default",
			},
			nowMs: NOW,
			origin: "https://app.maple.dev",
			referrerPath: "/traces",
		}),
	)

const historyLoaded = (model: Model, tabId: string) =>
	step(
		model,
		Message.GotConversationMessage({
			tabId,
			message: ConversationMessage.CompletedLoadHistory({
				generation: 1,
				result: Result.succeed({ messages: [], cursor: 0, running: false }),
			}),
		}),
	)

const postedText = (result: ReturnType<typeof step>) => {
	const post = result.commands?.find((command) => command.name === "PostChatMessage")
	return post?.args !== undefined && "text" in post.args ? String(post.args.text) : ""
}

describe("chat subjects", () => {
	test("an alert link adds and activates its own tab, keeping the alert in the URL", () => {
		const result = entered({ mode: "alert", alert: ALERT })
		expect(result.model.tabs?.tabs.map((tab) => tab.id)).toEqual(["default", "alert-inc-0000-a1e7"])
		expect(result.model.tabs?.tabs[1]?.title).toBe("Checkout p95 latency over bu…")
		expect(result.model.tabs?.activeTabId).toBe("alert-inc-0000-a1e7")
		expect(result.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/chat?mode=alert&alert=${ALERT}&tab=alert-inc-0000-a1e7`,
				isReplace: true,
			}),
		)
	})

	test("the alert's first message carries the alert block instead of the page context", () => {
		const ready = historyLoaded(
			entered({ mode: "alert", alert: ALERT }).model,
			"alert-inc-0000-a1e7",
		).model
		const sent = postedText(
			step(
				ready,
				Message.GotConversationMessage({
					tabId: "alert-inc-0000-a1e7",
					message: ConversationMessage.ClickedSuggestion({ text: "Why?" }),
				}),
			),
		)
		expect(sent).toContain("## Attached Alert")
		expect(sent).toContain('observed: "1.84s vs 800.0ms"')
		expect(sent).not.toContain("## Current Page Context")
		// Another tab on the same page still sends the page it was opened from.
		const other = historyLoaded(ready, "default").model
		const plain = postedText(
			step(
				other,
				Message.GotConversationMessage({
					tabId: "default",
					message: ConversationMessage.ClickedSuggestion({ text: "Hi" }),
				}),
			),
		)
		expect(plain).toContain("- view: traces explorer")
	})

	test("a widget-fix thread sends its fix prompt once its empty history is read, and only once", () => {
		const model = entered({ mode: "widget-fix", widget: WIDGET }).model
		expect(model.tabs?.activeTabId).toBe("widget-fix-dash-1-w-1")
		const sent = historyLoaded(model, "widget-fix-dash-1-w-1")
		expect(postedText(sent)).toContain("## Broken Widget")
		expect(postedText(sent)).toContain("Fix this widget")
		expect(sent.model.conversations["widget-fix-dash-1-w-1"]?.status).toBe("submitted")
		expect(postedText(step(sent.model, Message.CompletedSaveTabs()))).toBe("")
	})

	test("a widget-fix thread whose history read failed shows a retry and sends nothing until it loads", () => {
		const model = entered({ mode: "widget-fix", widget: WIDGET }).model
		const tabId = "widget-fix-dash-1-w-1"
		const failed = step(
			model,
			Message.GotConversationMessage({
				tabId,
				message: ConversationMessage.CompletedLoadHistory({
					generation: 1,
					result: Result.fail("Service unavailable"),
				}),
			}),
		)
		expect(postedText(failed)).toBe("")
		scene(
			{ update: step, view: withViewInputs(view, { context })() },
			given(failed.model),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			expectView(text("Couldn't load this conversation")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		const retried = step(
			failed.model,
			Message.GotConversationMessage({ tabId, message: ConversationMessage.ClickedRetryHistory() }),
		)
		expect(postedText(retried)).toBe("")
		const loaded = step(
			retried.model,
			Message.GotConversationMessage({
				tabId,
				message: ConversationMessage.CompletedLoadHistory({
					generation: 2,
					result: Result.succeed({ messages: [], cursor: 0, running: false }),
				}),
			}),
		)
		expect(postedText(loaded)).toContain("Fix this widget")
	})

	test("an undecodable subject is ignored", () => {
		expect(entered({ mode: "alert", alert: "not-base64!" }).model.subject).toBeNull()
	})

	test("the subject's card, suggestions and placeholder are drawn above its empty thread", () => {
		const ready = historyLoaded(
			entered({ mode: "alert", alert: ALERT }).model,
			"alert-inc-0000-a1e7",
		).model
		scene(
			{ update: step, view: withViewInputs(view, { context })() },
			given(ready),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			Mount.resolve(MountStopClickPropagation, MountMessage.CompletedMountStopClick()),
			expectView(text("Attached alert")).toExist(),
			expectView(text("Ready to investigate")).toExist(),
			expectView(role("button", { name: "Slowest operations in checkout-api right now" })).toExist(),
			expectView(placeholder("Ask about this alert…")).toExist(),
		)
		expect(ready.subject?._tag).toBe("Investigation")
	})
})
