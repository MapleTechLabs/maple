import { Result } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message } from "./model"
import { init, revisit, searchChanged, update } from "./update"
import { view } from "./view"

const page = { data: [], has_more: true, next_cursor: "cursor_2" }

describe("audit log tab", () => {
	test("entry fetches the first page for the URL's filters", () => {
		const entered = init({ outcome: "denied" })
		expect(entered.commands?.[0]).toMatchObject({ name: "FetchAuditLogPage", args: { request: { outcome: "denied" } } })
	})

	test("an answer for a superseded request is dropped", () => {
		const entered = init({}).model
		const moved = searchChanged(entered, { outcome: "denied" }).model
		const stale = update(moved, Message.CompletedFetchPage({ request: {}, resolvedSince: null, result: Result.succeed(page) }), { outcome: "denied" })
		expect(stale.model.view).toBeNull()
	})

	test("a filter click replaces the URL's audit params, keeping the tab", () => {
		const step = update(init({ tab: "audit-log" }).model, Message.ClickedActorType({ value: "api_key" }), { tab: "audit-log" })
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=audit-log&actor_type=api_key", isReplace: true }),
		)
	})

	test("a rolling preset keeps the window its list started with until Refresh or a filter change", () => {
		const search = { range: "24h" }
		const started = init(search)
		expect(started.commands?.[0]).toMatchObject({ args: { presetMs: 86_400_000, resolvedSince: null } })
		const since = "2026-10-19T10:00:00.000Z"
		const loaded = update(
			started.model,
			Message.CompletedFetchPage({ request: started.model.request, resolvedSince: since, result: Result.succeed(page) }),
			search,
		).model
		expect(update(loaded, Message.ClickedLoadMore(), search).commands?.[0]).toMatchObject({ args: { resolvedSince: since } })
		expect(update(loaded, Message.ClickedRetry(), search).commands?.[0]).toMatchObject({ args: { resolvedSince: since } })
		expect(update(loaded, Message.ClickedRefresh(), search).commands?.[0]).toMatchObject({ args: { resolvedSince: null } })
	})

	test("the Person filter names the selected member from the org's memberships", () => {
		const members = [{ value: "user_ada", label: "Ada Lovelace" }]
		const loaded = update(init({ actor: "user_ada" }).model, Message.CompletedFetchMembers({ members }), {
			actor: "user_ada",
		}).model
		scene(
			{
				update: (model, message) => update(model, message, { actor: "user_ada" }),
				view: withViewInputs(view, { search: { actor: "user_ada" }, nowMs: 0, timeZone: "UTC", apiKeys: [] })(),
			},
			given(loaded),
			expectView(role("combobox", { name: "Person" })).toHaveText("Ada Lovelace"),
		)
	})

	test("Load more pins the ceiling to the newest entry and asks for the next cursor", () => {
		const loaded = update(
			init({}).model,
			Message.CompletedFetchPage({ request: {}, resolvedSince: null, result: Result.succeed(page) }),
			{},
		).model
		expect(update(loaded, Message.ClickedLoadMore(), {}).commands?.[0]).toMatchObject({
			args: { request: { cursor: "cursor_2" } },
		})
	})

	test("a revisit reads the first page quietly and holds Load more until it lands", () => {
		const loaded = update(init({}).model, Message.CompletedFetchPage({ request: {}, resolvedSince: null, result: Result.succeed(page) }), {}).model
		const back = revisit(loaded, {})
		expect(back.commands?.map(({ name }) => name)).toEqual(["FetchAuditLogPage"])
		// The old list's cursor would continue a page the refresh is about to replace.
		expect(update(back.model, Message.ClickedLoadMore(), {}).commands ?? []).toEqual([])
	})

	test("a revisit while the same first page is in flight does not read it twice", () => {
		expect(revisit(init({}).model, {}).commands ?? []).toEqual([])
	})
})
