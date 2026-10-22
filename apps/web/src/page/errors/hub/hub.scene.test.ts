import { OrgId } from "@maple/domain"
import { V2ErrorIssue } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, label, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { MeasureTabIndicator, Message as TabsMessage } from "../../../ui/tabs"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { FetchInvestigations, FetchPage, MountFilterRail, MountRowSelect } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const RECT = { left: 2, right: 115, top: 2, bottom: 2, width: 51, height: 28 }
const measured = Mount.resolve(MeasureTabIndicator, TabsMessage.MeasuredIndicator({ rect: RECT }))
const railMounted = Mount.resolve(MountFilterRail, Message.MountedFilterRail())

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const issue = (overrides: Partial<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2ErrorIssue)({
		id: "iss_YoxMYDoXSr3tsBZyBLmNMv",
		object: "error_issue",
		kind: "error",
		fingerprint_hash: "12660752272409977512",
		service_name: "payment-svc",
		exception_type: "ConnectionTimeout",
		exception_message: "timed out acquiring a connection",
		error_label: "ConnectionTimeout",
		top_frame: "",
		workflow_state: "triage",
		priority: 1,
		severity: "critical",
		severity_source: "detector",
		source_ref: null,
		assigned_actor: null,
		lease_holder: null,
		lease_expires_at: null,
		claimed_at: null,
		notes: null,
		first_seen_at: "2026-10-01T10:00:00.000Z",
		last_seen_at: "2026-10-01T11:44:00.000Z",
		occurrence_count: 12,
		resolved_at: null,
		last_resolved_at: null,
		last_regressed_at: null,
		regression_count: 0,
		resolved_versions: [],
		snooze_until: null,
		archived_at: null,
		has_open_incident: true,
		comment_count: 0,
		open_pull_request_count: 0,
		merged_pull_request_count: 0,
		...overrides,
	})

/** Entered and windowed: every query in flight. */
const windowed = (search = {}): Model => {
	const entered = init({ search }, context).model
	const resolved = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(resolved, Message.MountedFilterRail()).model
}

const withPage = (model: Model, data: ReadonlyArray<V2ErrorIssue>): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchPage({
			key: model.pages[0]?.page.key ?? "",
			result: Result.succeed({ data, hasMore: false, nextCursor: null }),
		}),
	).model

const RANKING_FAILURE = { ...toLoadFailure(new Error("boom")), message: "The ranking store timed out." }

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status, lastSeenMs: null } }),
		}),
	).model

describe("errors hub", () => {
	test("entry resolves the day window, then asks the summary, first page and investigations, and the sidebar once it mounts", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveErrorsWindow")
		const entered = init({ search: {} }, context).model
		const resolved = pageUpdate(
			entered,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining(["FetchErrorsSummary", FetchInvestigations.name, FetchPage.name]),
		)
		const mounted = pageUpdate(resolved.model, Message.MountedFilterRail())
		expect(names(mounted.commands)).toEqual(
			expect.arrayContaining(["FetchErrorIssueServiceCounts", "FetchErrorsEnvironments"]),
		)
	})

	test("loaded rows ask volume and trend for exactly their fingerprints", () => {
		const model = windowed()
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchPage({
				key: model.pages[0]?.page.key ?? "",
				result: Result.succeed({ data: [issue()], hasMore: false, nextCursor: null }),
			}),
		)
		expect(names(loaded.commands)).toEqual(
			expect.arrayContaining(["FetchErrorsVolume", "FetchErrorsSpark"]),
		)
	})

	test("a page answer for a superseded list query is dropped", () => {
		const first = windowed()
		const staleKey = first.pages[0]?.page.key ?? ""
		const closed = routeChanged(first, { search: { view: "closed" } }, context).model
		const late = pageUpdate(
			closed,
			Message.CompletedFetchPage({
				key: staleKey,
				result: Result.succeed({ data: [issue()], hasMore: false, nextCursor: null }),
			}),
		)
		expect(late.model.pages).toEqual(closed.pages)
	})

	test("the volume sort waits for the warehouse ranking before asking for issues", () => {
		const model = windowed({ sort: "volume" })
		expect(model.pages).toEqual([])
		const ranked = pageUpdate(
			model,
			Message.CompletedFetchRanking({
				key: model.ranking.key ?? "",
				result: Result.succeed(["1", "2"]),
			}),
		)
		expect(names(ranked.commands)).toEqual([FetchPage.name])
	})

	test("a failed volume ranking shows the list's failure, and Retry asks the ranking again", () => {
		const model = windowed({ sort: "volume" })
		const failed = pageUpdate(
			model,
			Message.CompletedFetchRanking({
				key: model.ranking.key ?? "",
				result: Result.fail(RANKING_FAILURE),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			measured,
			railMounted,
			expectView(text("Failed to load errors")).toExist(),
			expectView(text(RANKING_FAILURE.message)).toExist(),
			expectView(text(toLoadFailure("The errors list could not be loaded.").message)).not.toExist(),
		)
		const retried = pageUpdate(failed.model, Message.ClickedRetry())
		expect(names(retried.commands)).toEqual(["FetchErrorsRanking"])
		const ranked = pageUpdate(
			retried.model,
			Message.CompletedFetchRanking({
				key: retried.model.ranking.key ?? "",
				result: Result.succeed(["1"]),
			}),
		)
		expect(names(ranked.commands)).toEqual([FetchPage.name])
	})

	test("a filter change under the volume sort waits for the new ranking, not the retained one", () => {
		const model = windowed({ sort: "volume" })
		const ranked = pageUpdate(
			model,
			Message.CompletedFetchRanking({
				key: model.ranking.key ?? "",
				result: Result.succeed(["1", "2"]),
			}),
		).model
		const filtered = routeChanged(ranked, { search: { sort: "volume", service: "payment-svc" } }, context)
		expect(names(filtered.commands)).toContain("FetchErrorsRanking")
		expect(names(filtered.commands)).not.toContain(FetchPage.name)
		const reranked = pageUpdate(
			filtered.model,
			Message.CompletedFetchRanking({
				key: filtered.model.ranking.key ?? "",
				result: Result.succeed(["3"]),
			}),
		)
		expect(names(reranked.commands)).toEqual([FetchPage.name])
		expect(reranked.model.listKey).toContain('"fingerprint_hash":"3"')
	})

	test("a Reload under the volume sort keeps the ranked rows on screen while the ranking re-reads", () => {
		const model = windowed({ sort: "volume" })
		const ranked = pageUpdate(
			model,
			Message.CompletedFetchRanking({
				key: model.ranking.key ?? "",
				result: Result.succeed(["1", "2"]),
			}),
		).model
		const listed = withPage(ranked, [issue()])
		expect(listed.pages).toHaveLength(1)
		const later = { startTime: "2026-09-30 12:05:00", endTime: "2026-10-01 12:05:00" }
		const reloaded = pageUpdate(
			listed,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Refresh" }),
		)
		expect(names(reloaded.commands)).toContain("FetchErrorsRanking")
		expect(reloaded.model.listKey).toBe(listed.listKey)
		expect(reloaded.model.pages).toEqual(listed.pages)
	})

	test("rows render as links to the issue, newest first", () => {
		scene(
			{ update: pageUpdate, view },
			given(withPage(windowed(), [issue()])),
			measured,
			railMounted,
			Mount.resolve(MountRowSelect, Message.ClickedRowSelect({ id: "", isShift: false })),
			expectView(role("link", { name: /ConnectionTimeout/ })).toHaveAttr(
				"href",
				"/errors/issues/0199a004-0000-7000-8000-000000000001",
			),
			expectView(text("1 issue")).toExist(),
		)
	})

	test("ticking a service and removing its chip write the URL search", () => {
		const model = withPage(windowed(), [issue()])
		expect(
			pageUpdate(model, Message.ToggledFilterOption({ param: "service", name: "payment-svc" }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/errors?service=payment-svc", isReplace: false }),
		)
		const filtered = { ...model, search: { service: "payment-svc" } }
		expect(
			pageUpdate(filtered, Message.ToggledFilterOption({ param: "service", name: "payment-svc" }))
				.outMessage,
		).toEqual(PageOutMessage.RequestedNavigation({ url: "/errors", isReplace: false }))
	})

	test("selecting rows toggles one at a time, and the header takes all or none", () => {
		const model = withPage(windowed(), [issue()])
		const one = pageUpdate(
			model,
			Message.ToggledRow({ id: "0199a004-0000-7000-8000-000000000001" }),
		).model
		expect(one.selectedIds).toEqual(["0199a004-0000-7000-8000-000000000001"])
		expect(pageUpdate(one, Message.ToggledAllRows()).model.selectedIds).toEqual([])
	})

	test("an empty org shows a skeleton until presence is known, never the 'No open errors' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadErrorsSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(withPage(windowed(), [])),
			measured,
			railMounted,
			expectView(text("No open errors")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(withPage(windowed(), []), "absent")),
			measured,
			railMounted,
			expectView(text("No errors yet")).toExist(),
		)
	})

	test("the search box navigates once its debounce elapses, with the trimmed term", () => {
		const model = withPage(windowed(), [issue()])
		const typed = pageUpdate(model, Message.ChangedSearchDraft({ value: " pool " }))
		expect(names(typed.commands)).toEqual(["WaitErrorsSearchDebounce"])
		const stale = pageUpdate(typed.model, Message.ElapsedSearchDebounce({ generation: 0 }))
		expect(stale.outMessage).toBeUndefined()
		const fired = pageUpdate(
			typed.model,
			Message.ElapsedSearchDebounce({ generation: typed.model.searchGeneration }),
		)
		expect(fired.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/errors?q=pool", isReplace: false }),
		)
	})
})
