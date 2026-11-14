import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { AUDIT_ENTRIES, AUDIT_MEMBERS, AUDIT_NOW } from "../../../lab/audit-log-fixture"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import * as CustomRange from "../../kit/custom-range"
import { Message } from "./model"
import { init, revisit, searchChanged, update } from "./update"
import { view } from "./view"
import { entryHref } from "./view-detail"
import { SettingsSearch } from "../../../route/search"

const page = { data: [], has_more: true, next_cursor: "cursor_2" }

describe("audit log tab", () => {
	test("entry fetches the first page for the URL's filters", () => {
		const entered = init({ outcome: "denied" })
		expect(entered.commands?.[0]).toMatchObject({
			name: "FetchAuditLogPage",
			args: { request: { outcome: "denied" } },
		})
	})

	test("an answer for a superseded request is dropped", () => {
		const entered = init({}).model
		const moved = searchChanged(entered, { outcome: "denied" }).model
		const stale = update(
			moved,
			Message.CompletedFetchPage({
				request: init({}).model.request,
				resolvedSince: null,
				result: Result.succeed(page),
			}),
			{ outcome: "denied" },
		)
		expect(stale.model.view).toBeNull()
	})

	test("a filter click replaces the URL's audit params, keeping the tab", () => {
		const step = update(
			init({ tab: "audit-log" }).model,
			Message.ClickedActorType({ value: "api_key" }),
			{ tab: "audit-log" },
		)
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&actor_type=api_key",
				isReplace: true,
			}),
		)
	})

	test("a rolling preset keeps the window its list started with until Refresh or a filter change", () => {
		const search = { range: "24h" }
		const started = init(search)
		expect(started.commands?.[0]).toMatchObject({ args: { presetMs: 86_400_000, resolvedSince: null } })
		const since = "2026-10-19T10:00:00.000Z"
		const loaded = update(
			started.model,
			Message.CompletedFetchPage({
				request: started.model.request,
				resolvedSince: since,
				result: Result.succeed(page),
			}),
			search,
		).model
		expect(update(loaded, Message.ClickedLoadMore(), search).commands?.[0]).toMatchObject({
			args: { resolvedSince: since },
		})
		expect(update(loaded, Message.ClickedRetry(), search).commands?.[0]).toMatchObject({
			args: { resolvedSince: since },
		})
		expect(update(loaded, Message.ClickedRefresh(), search).commands?.[0]).toMatchObject({
			args: { resolvedSince: null },
		})
	})

	test("the Person filter names the selected member from the org's memberships", () => {
		const members = [{ value: "user_ada", label: "Ada Lovelace" }]
		const loaded = update(init({ actor: "user_ada" }).model, Message.CompletedFetchMembers({ members }), {
			actor: "user_ada",
		}).model
		scene(
			{
				update: (model, message) => update(model, message, { actor: "user_ada" }),
				view: withViewInputs(view, {
					search: { actor: "user_ada" },
					nowMs: 0,
					timeZone: "UTC",
					apiKeys: [],
				})(),
			},
			given(loaded),
			expectView(role("combobox", { name: "Person" })).toHaveText("Ada Lovelace"),
		)
	})

	test("Load more pins the ceiling to the newest entry and asks for the next cursor", () => {
		const entered = init({}).model
		const loaded = update(
			entered,
			Message.CompletedFetchPage({
				request: entered.request,
				resolvedSince: null,
				result: Result.succeed(page),
			}),
			{},
		).model
		expect(update(loaded, Message.ClickedLoadMore(), {}).commands?.[0]).toMatchObject({
			args: { request: { cursor: "cursor_2" } },
		})
	})

	test("a revisit reads the first page quietly and holds Load more until it lands", () => {
		const entered = init({}).model
		const loaded = update(
			entered,
			Message.CompletedFetchPage({
				request: entered.request,
				resolvedSince: null,
				result: Result.succeed(page),
			}),
			{},
		).model
		const back = revisit(loaded, {})
		expect(Arr.map(back.commands ?? [], ({ name }) => name)).toEqual(["FetchAuditLogPage"])
		// The old list's cursor would continue a page the refresh is about to replace.
		expect(update(back.model, Message.ClickedLoadMore(), {}).commands ?? []).toEqual([])
	})

	test("a revisit while the same first page is in flight does not read it twice", () => {
		expect(revisit(init({}).model, {}).commands ?? []).toEqual([])
	})

	test("the list opens on changes, and the kind switch writes access or all to the URL", () => {
		const entered = init({ tab: "audit-log" })
		expect(entered.commands?.[0]).toMatchObject({ args: { request: { kind: "changes" } } })
		expect(init({ kind: "all" }).model.request.kind).toBeUndefined()
		const step = update(entered.model, Message.ClickedKind({ value: "access" }), { tab: "audit-log" })
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&kind=access",
				isReplace: true,
			}),
		)
		const back = update(entered.model, Message.ClickedKind({ value: "changes" }), {
			tab: "audit-log",
			kind: "access",
		})
		expect(back.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=audit-log", isReplace: true }),
		)
	})

	test("a pasted id becomes the filter it stands for; anything else says what the lookup takes", () => {
		const search = { tab: "audit-log" } as const
		const typed = update(
			init(search).model,
			Message.ChangedLookup({ value: " key_aXwpxqBkqtYwtBtmsGbR41 " }),
			search,
		)
		expect(update(typed.model, Message.SubmittedLookup(), search).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&actor=key_aXwpxqBkqtYwtBtmsGbR41",
				isReplace: true,
			}),
		)
		const ray = update(
			init(search).model,
			Message.ChangedLookup({ value: "8f2c1a9d4b7e3f60-FRA" }),
			search,
		)
		expect(update(ray.model, Message.SubmittedLookup(), search).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&request=8f2c1a9d4b7e3f60-FRA",
				isReplace: true,
			}),
		)
		const junk = update(init(search).model, Message.ChangedLookup({ value: "hello world" }), search)
		const refused = update(junk.model, Message.SubmittedLookup(), search)
		expect(refused.outMessage).toBeUndefined()
		scene(
			{
				update: (model, message) => update(model, message, search),
				view: withViewInputs(view, { search, nowMs: 0, timeZone: "UTC", apiKeys: [] })(),
			},
			given(refused.model),
			expectView(role("status")).toHaveText(/Not something the log filters by/),
		)
	})

	test("removing the resource type drops the action that belongs to it", () => {
		const search = {
			tab: "audit-log",
			resource_type: "dashboard",
			action: "dashboard.updated",
			outcome: "denied",
		} as const
		expect(
			update(init(search).model, Message.RemovedFilter({ key: "resourceType" }), search).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&outcome=denied",
				isReplace: true,
			}),
		)
	})

	test("an applied custom range lands in the URL as UTC instants", () => {
		const search = { tab: "audit-log" } as const
		const opened = update(
			init(search).model,
			Message.ResolvedCustomToday({
				timeZone: "UTC",
				today: { year: 2026, month: 11, day: 9 },
				lastDay: { year: 2026, month: 11, day: 9 },
			}),
			search,
		).model
		const start: ReturnType<typeof update> = { model: opened }
		const picked = Arr.reduce(
			[
				CustomRange.Message.ClickedDay({ date: { year: 2026, month: 11, day: 2 } }),
				CustomRange.Message.ClickedDay({ date: { year: 2026, month: 11, day: 4 } }),
				CustomRange.Message.ClickedApply(),
			],
			start,
			(step, message) => update(step.model, Message.GotCustomRangeMessage({ message }), search),
		)
		expect(picked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=audit-log&since=2026-11-02T00%3A00%3A00.000Z&until=2026-11-04T23%3A59%3A00.000Z",
				isReplace: true,
			}),
		)
		expect(picked.model.customRange).toBeNull()
	})

	test("opening the custom range moves focus into the popover, so Escape still closes it", () => {
		const search = { tab: "audit-log" } as const
		const opened = update(
			init(search).model,
			Message.ResolvedCustomToday({
				timeZone: "UTC",
				today: { year: 2026, month: 11, day: 9 },
				lastDay: { year: 2026, month: 11, day: 9 },
			}),
			search,
		)
		expect(Arr.map(opened.commands ?? [], ({ name }) => name)).toEqual(["FocusAuditDateRange"])
	})

	describe("an entry's detail", () => {
		const search = { tab: "audit-log" } as const
		const loadedWith = (searchFor: typeof SettingsSearch.Type) => {
			const entered = init(searchFor).model
			const withMembers = update(
				entered,
				Message.CompletedFetchMembers({ members: AUDIT_MEMBERS }),
				searchFor,
			).model
			return update(
				withMembers,
				Message.CompletedFetchPage({
					request: entered.request,
					resolvedSince: null,
					result: Result.succeed({ data: AUDIT_ENTRIES, has_more: false, next_cursor: null }),
				}),
				searchFor,
			)
		}
		const sceneOf = (searchFor: Parameters<typeof loadedWith>[0]) => ({
			update: (model: ReturnType<typeof init>["model"], message: Message) =>
				update(model, message, searchFor),
			view: withViewInputs(view, {
				search: searchFor,
				nowMs: AUDIT_NOW,
				timeZone: "UTC",
				apiKeys: [],
			})(),
		})

		test("names a member the entry froze no name for, from the org's memberships", () => {
			scene(
				sceneOf(search),
				given(loadedWith(search).model),
				expectView(text("Linus Torvalds")).toExist(),
			)
		})

		test("Filter beside the actor lists that actor's entries of any type", () => {
			const step = update(
				loadedWith({ ...search }).model,
				Message.ClickedPivot({ key: "actorId", value: "key_aXwpxqBkqtYwtBtmsGbR41" }),
				{ tab: "audit-log", actor_type: "user" },
			)
			expect(step.outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: "/settings?tab=audit-log&actor=key_aXwpxqBkqtYwtBtmsGbR41",
					isReplace: true,
				}),
			)
		})

		test("Filter beside the action also picks its resource type, so the action select shows it", () => {
			const step = update(
				loadedWith(search).model,
				Message.ClickedPivot({ key: "action", value: "dashboard.updated" }),
				search,
			)
			expect(step.outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: "/settings?tab=audit-log&resource_type=dashboard&action=dashboard.updated",
					isReplace: true,
				}),
			)
		})

		test("Filter from a shared entry link leaves that link's one-minute window", () => {
			const target = AUDIT_ENTRIES[5]
			if (target === undefined) throw new Error("fixture")
			const linked = Schema.decodeSync(SettingsSearch)(
				Rec.fromEntries([...new URL(entryHref(target), "https://maple.test").searchParams.entries()]),
			)
			const step = update(
				loadedWith(linked).model,
				Message.ClickedPivot({ key: "actorId", value: "key_aXwpxqBkqtYwtBtmsGbR41" }),
				linked,
			)
			expect(step.outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: "/settings?tab=audit-log&actor=key_aXwpxqBkqtYwtBtmsGbR41&kind=all",
					isReplace: true,
				}),
			)
		})

		test("a shared entry link opens that entry and scrolls to it", () => {
			const target = AUDIT_ENTRIES[2]
			if (target === undefined) throw new Error("fixture")
			const linked = {
				tab: "audit-log",
				entry: encodePublicId(PublicIdPrefixes.auditLogEntry, target.id),
			} as const
			const loaded = loadedWith(linked)
			expect(loaded.model.expanded).toEqual([target.id])
			expect(Arr.map(loaded.commands ?? [], ({ name }) => name)).toEqual(["ScrollToAuditEntry"])
		})

		test("rows sit under a heading for each day, counted in the viewer's zone", () => {
			scene(
				sceneOf(search),
				given(loadedWith(search).model),
				expectView(role("heading", { name: "Today" })).toExist(),
				expectView(role("heading", { name: "Yesterday" })).toExist(),
			)
		})

		test("a shared entry link still opens its entry when it arrives on a later page", () => {
			const target = AUDIT_ENTRIES[5]
			if (target === undefined) throw new Error("fixture")
			const linked = {
				tab: "audit-log",
				entry: encodePublicId(PublicIdPrefixes.auditLogEntry, target.id),
			} as const
			const entered = init(linked).model
			const first = update(
				entered,
				Message.CompletedFetchPage({
					request: entered.request,
					resolvedSince: null,
					result: Result.succeed({
						data: AUDIT_ENTRIES.slice(0, 3),
						has_more: true,
						next_cursor: "cursor_2",
					}),
				}),
				linked,
			).model
			expect(first.expanded).toEqual([])
			const asked = update(first, Message.ClickedLoadMore(), linked).model
			const second = update(
				asked,
				Message.CompletedFetchPage({
					request: asked.request,
					resolvedSince: null,
					result: Result.succeed({
						data: AUDIT_ENTRIES.slice(3),
						has_more: false,
						next_cursor: null,
					}),
				}),
				linked,
			)
			expect(second.model.expanded).toEqual([target.id])
			expect(Arr.map(second.commands ?? [], ({ name }) => name)).toEqual(["ScrollToAuditEntry"])
		})

		test("a filter change leaves a shared entry link behind", () => {
			const linked = { tab: "audit-log", entry: "alog_gQUY7khzfVuTjEMzpTTstW" } as const
			const step = update(init(linked).model, Message.ClickedOutcome({ value: "denied" }), linked)
			expect(step.outMessage).toEqual(
				PageOutMessage.RequestedNavigation({
					url: "/settings?tab=audit-log&outcome=denied",
					isReplace: true,
				}),
			)
		})

		test("an entry's link lists the minute that ends at the entry, and opens it", () => {
			const target = AUDIT_ENTRIES[5]
			if (target === undefined) throw new Error("fixture")
			const linked = Schema.decodeSync(SettingsSearch)(
				Rec.fromEntries([...new URL(entryHref(target), "https://maple.test").searchParams.entries()]),
			)
			// The fixture's sixth entry happened 47 minutes before `AUDIT_NOW`.
			expect(linked).toEqual({
				tab: "audit-log",
				kind: "all",
				since: new Date(AUDIT_NOW - 48 * 60_000).toISOString(),
				until: new Date(AUDIT_NOW - 47 * 60_000).toISOString(),
				entry: encodePublicId(PublicIdPrefixes.auditLogEntry, target.id),
			})
			expect(loadedWith(linked).model.expanded).toEqual([target.id])
		})

		test("an entry Maple itself made still names its surface", () => {
			const target = Arr.findFirst(AUDIT_ENTRIES, (entry) => entry.source === "system")
			if (Option.isNone(target)) throw new Error("fixture")
			const opened = update(
				loadedWith(search).model,
				Message.ToggledEntry({ id: target.value.id }),
				search,
			).model
			scene(sceneOf(search), given(opened), expectView(text("Surface")).toExist())
		})

		test("an open entry offers a filter beside its actor, action and resource", () => {
			const target = AUDIT_ENTRIES[2]
			if (target === undefined) throw new Error("fixture")
			const opened = update(
				loadedWith(search).model,
				Message.ToggledEntry({ id: target.id }),
				search,
			).model
			scene(
				sceneOf(search),
				given(opened),
				expectView(role("button", { name: "Show every entry with this actor" })).toExist(),
				expectView(role("button", { name: "Show every entry with this action" })).toExist(),
				expectView(role("button", { name: "Show every entry with this resource" })).toExist(),
			)
		})

		test("a row names the kind of actor behind an API key", () => {
			scene(
				sceneOf(search),
				given(loadedWith(search).model),
				expectView(role("img", { name: "API key" })).toExist(),
			)
		})

		test("the Origin section names the country an entry came from", () => {
			const target = AUDIT_ENTRIES[4]
			if (target === undefined) throw new Error("fixture")
			const opened = update(
				loadedWith(search).model,
				Message.ToggledEntry({ id: target.id }),
				search,
			).model
			scene(sceneOf(search), given(opened), expectView(text(/United Kingdom \(GB\)/)).toExist())
		})
	})
})
