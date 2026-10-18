import { Result } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message } from "./model"
import { init, searchChanged, update } from "./update"

const page = { data: [], has_more: true, next_cursor: "cursor_2" }

describe("audit log tab", () => {
	test("entry fetches the first page for the URL's filters", () => {
		const entered = init({ outcome: "denied" })
		expect(entered.commands?.[0]).toMatchObject({ name: "FetchAuditLogPage", args: { request: { outcome: "denied" } } })
	})

	test("an answer for a superseded request is dropped", () => {
		const entered = init({}).model
		const moved = searchChanged(entered, { outcome: "denied" }).model
		const stale = update(moved, Message.CompletedFetchPage({ request: {}, result: Result.succeed(page) }), { outcome: "denied" })
		expect(stale.model.view).toBeNull()
	})

	test("a filter click replaces the URL's audit params, keeping the tab", () => {
		const step = update(init({ tab: "audit-log" }).model, Message.ClickedActorType({ value: "api_key" }), { tab: "audit-log" })
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=audit-log&actor_type=api_key", isReplace: true }),
		)
	})

	test("Load more pins the ceiling to the newest entry and asks for the next cursor", () => {
		const loaded = update(
			init({}).model,
			Message.CompletedFetchPage({ request: {}, result: Result.succeed(page) }),
			{},
		).model
		expect(update(loaded, Message.ClickedLoadMore(), {}).commands?.[0]).toMatchObject({
			args: { request: { cursor: "cursor_2" } },
		})
	})
})
