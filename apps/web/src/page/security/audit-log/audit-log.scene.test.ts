import { OrgId } from "@maple/domain"
import { AuditTrailForbiddenError, AuditTrailPersistenceError } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr, String as Str } from "effect"
import { expect as expectView, given, role, scene, text, within, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { auditEventsOf, noAuditEvents } from "../../../lab/security-audit-log-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { eventsOf, nextCursorOf } from "./derive"
import { type EventsPage, Message, type Model, type Search } from "./model"
import { enter, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 31, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const FIRST_PAGE = "SecurityApiAuditLogFirstPage"
const NEXT_PAGE = "SecurityApiAuditLogNextPage"

const routeOf = (search: Search = {}) => AppRoute.SecurityAuditLog({ search })
/** The hosted product: the session, not the build, says what the viewer may read. */
const init = (route: ReturnType<typeof routeOf>, pageContext: PageContext) => enter(route, pageContext, true)
const ADMIN = Policy.allPermissions
const ENGINEER = Policy.grantsOf(["org:engineer"])
const eventsTable = role("table", { name: "Audit events" })

const fold = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) => () =>
	Message.CompletedReadGrants({ orgId: context.orgId, grants: [...grants] })

const firstPage = (page: EventsPage) => (model: Model) =>
	Message.CompletedFetchFirstPage({ key: model.firstPage.key ?? "", result: Result.succeed(page) })

const firstPageFailed = (error: unknown) => (model: Model) =>
	Message.CompletedFetchFirstPage({
		key: model.firstPage.key ?? "",
		result: Result.fail(toLoadFailure(error)),
	})

const PAGE = auditEventsOf(NOW)

/** The page as an admin sees it once the first page answered. */
const loaded = (page: EventsPage = PAGE, search: Search = {}): Model =>
	fold(init(routeOf(search), context).model, [
		() => Message.ReadClock({ nowMs: NOW }),
		grantsRead(ADMIN),
		firstPage(page),
	])

/** The answer to the next-page request `model` has in flight. */
const nextPage = (model: Model, result: Result.Result<EventsPage, ReturnType<typeof toLoadFailure>>) =>
	Message.CompletedFetchNextPage({
		key: model.laterPages.key ?? "",
		generation: model.laterPages.generation,
		cursor: nextCursorOf(model) ?? "",
		result,
	})

/** A second page: the same events three days older, under other ids, its cursor on its own last event. */
const olderPage = (hasMore: boolean): EventsPage => {
	const events = Arr.map(auditEventsOf(NOW - 3 * 24 * 3600 * 1000).events, (event) => ({
		...event,
		id: `f${Str.slice(1)(event.id)}`,
	}))
	const last = events.at(-1)
	return { events, nextCursor: hasMore && last !== undefined ? `${last.occurredAt}:${last.id}` : null }
}

const down = toLoadFailure(new AuditTrailPersistenceError({ message: "The audit trail could not be read" }))

describe("security audit log", () => {
	test("nothing is asked of the API until the session says who is looking", () => {
		expect(names(init(routeOf(), context).commands)).not.toContain(FIRST_PAGE)
	})

	test("a self-hosted install has one role, so the first page is asked for on entry", () => {
		expect(names(enter(routeOf(), context, false).commands)).toContain(FIRST_PAGE)
	})

	test("an engineer is told the log is for admins and nothing is asked of the API", () => {
		const answered = pageUpdate(init(routeOf(), context).model, grantsRead(ENGINEER)())

		expect(names(answered.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(text(Policy.denialFor("audit_log:read").message)).toExist(),
			expectView(eventsTable).toBeAbsent(),
		)
	})

	test("an admin's session answer asks for the first page", () => {
		const answered = pageUpdate(init(routeOf(), context).model, grantsRead(ADMIN)())

		expect(names(answered.commands)).toEqual([FIRST_PAGE])
	})

	// A failed session read answers with no grants at all. That is "unknown", not "member": an
	// admin must not be locked out of the log by it.
	test("a session that could not be read asks the API, and the API's refusal is what locks the page", () => {
		const asked = pageUpdate(init(routeOf(), context).model, grantsRead([])())
		expect(names(asked.commands)).toEqual([FIRST_PAGE])

		scene(
			{ update: pageUpdate, view },
			given(fold(asked.model, [firstPage(PAGE)])),
			expectView(eventsTable).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				fold(asked.model, [
					firstPageFailed(
						new AuditTrailForbiddenError({ message: "Only org admins can read the audit log." }),
					),
				]),
			),
			expectView(text(Policy.denialFor("audit_log:read").message)).toExist(),
			expectView(role("button", { name: "Try again" })).toBeAbsent(),
		)
	})

	test("lists who did what, marks a refusal with its reason and groups the events by day", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(within(eventsTable, text("Ada Lovelace"))).toExist(),
			expectView(within(eventsTable, text("alert_rule.updated"))).toExist(),
			expectView(within(eventsTable, text("Denied"))).toExist(),
			expectView(within(eventsTable, text("The key lacks the dashboards:write scope."))).toExist(),
			expectView(within(eventsTable, text("Today"))).toExist(),
			expectView(role("button", { name: "Load more" })).toExist(),
		)
	})

	// The toggle's label replaces its content for a screen reader: without the time in it, the
	// row would say what happened and never when.
	test("each filter is named for what it filters, whatever value it shows", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(PAGE, { outcome: "denied" })),
			expectView(role("combobox", { name: "Outcome" })).toExist(),
			expectView(role("combobox", { name: "Category" })).toExist(),
		)
	})

	test("a row's toggle names the action and when it happened", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("button", { name: /Show details: alert_rule\.updated, .*2026/ })).toExist(),
		)
	})

	test("a log with no refusals shows no refusal mark", () => {
		const calm = { ...PAGE, events: Arr.filter(PAGE.events, (event) => event.outcome === "success") }

		scene(
			{ update: pageUpdate, view },
			given(loaded(calm)),
			expectView(within(eventsTable, text("Denied"))).toBeAbsent(),
		)
	})

	test("an outcome or category this build has no name for shows as itself, and is marked", () => {
		const [first] = PAGE.events
		const odd = first === undefined ? [] : [{ ...first, category: "licensing", outcome: "throttled" }]

		scene(
			{ update: pageUpdate, view },
			given(loaded({ events: odd, nextCursor: null })),
			expectView(within(eventsTable, text("licensing"))).toExist(),
			expectView(within(eventsTable, text("throttled"))).toExist(),
		)
	})

	test("opening an event shows what was recorded about it, and closing hides it", () => {
		const model = loaded()
		const first = eventsOf(model)?.[0]
		const opened = pageUpdate(model, Message.ToggledEvent({ id: first?.id ?? "" })).model

		scene(
			{ update: pageUpdate, view },
			given(opened),
			expectView(text("Payload")).toExist(),
			expectView(text(first?.providerEventId ?? "")).toExist(),
			expectView(text("203.0.113.7")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(opened, Message.ToggledEvent({ id: first?.id ?? "" })).model),
			expectView(text("Payload")).toBeAbsent(),
		)
	})

	test("a filter change goes to the URL, and choosing All drops it", () => {
		const denied = pageUpdate(loaded(), Message.ChangedFilter({ filter: "outcome", value: "denied" }))
		expect(denied.outMessage).toMatchObject({ url: hrefOf(routeOf({ outcome: "denied" })) })

		const cleared = pageUpdate(
			loaded(PAGE, { outcome: "denied", category: "credential" }),
			Message.ChangedFilter({ filter: "outcome", value: "" }),
		)
		expect(cleared.outMessage).toMatchObject({ url: hrefOf(routeOf({ category: "credential" })) })
	})

	test("the actor filter applies on Enter, trimmed, and not while typing", () => {
		const typed = pageUpdate(loaded(), Message.ChangedActorText({ value: "  ada@acme.test " }))
		expect(typed.outMessage).toBeUndefined()

		const submitted = pageUpdate(typed.model, Message.SubmittedActor())
		expect(submitted.outMessage).toMatchObject({ url: hrefOf(routeOf({ actor: "ada@acme.test" })) })
	})

	test("an actor typed but not applied survives a change of another filter", () => {
		const typed = pageUpdate(loaded(), Message.ChangedActorText({ value: "ada@acme.test" })).model

		expect(routeChanged(typed, routeOf({ outcome: "denied" }), context).model.actorText).toBe(
			"ada@acme.test",
		)
	})

	test("the actor field follows the URL when Back leaves an applied actor behind", () => {
		const applied = loaded(PAGE, { actor: "ada@acme.test" })

		expect(routeChanged(applied, routeOf(), context).model.actorText).toBe("")
	})

	test("load more continues from the last event shown and appends what comes back", () => {
		const asked = pageUpdate(loaded(), Message.ClickedLoadMore())

		expect(asked.commands?.[0]).toMatchObject({ name: NEXT_PAGE, args: { cursor: PAGE.nextCursor } })
		const older = olderPage(false)
		const appended = pageUpdate(asked.model, nextPage(asked.model, Result.succeed(older))).model
		expect(eventsOf(appended)).toHaveLength(PAGE.events.length + older.events.length)
		scene(
			{ update: pageUpdate, view },
			given(appended),
			expectView(role("button", { name: "Load more" })).toBeAbsent(),
		)
	})

	test("an event repeated across a page boundary shows once", () => {
		const asked = pageUpdate(loaded(), Message.ClickedLoadMore()).model
		const [repeated] = PAGE.events
		const overlapping = { events: repeated === undefined ? [] : [repeated], nextCursor: null }

		expect(eventsOf(pageUpdate(asked, nextPage(asked, Result.succeed(overlapping))).model)).toHaveLength(
			PAGE.events.length,
		)
	})

	// The rows on screen are the old filters' until the new first page lands. A next page asked
	// from their cursor would be the new filters' page two glued under the old page one.
	test("no next page is asked for, or accepted, while other filters are loading", () => {
		const inFlight = pageUpdate(loaded(), Message.ClickedLoadMore()).model
		const lateAnswer = nextPage(inFlight, Result.succeed(olderPage(true)))
		const changed = routeChanged(inFlight, routeOf({ outcome: "denied" }), context)

		expect(names(changed.commands)).toEqual([FIRST_PAGE])
		expect(names(pageUpdate(changed.model, Message.ClickedLoadMore()).commands)).toEqual([])
		expect(pageUpdate(changed.model, lateAnswer).model.laterPages.pages).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(changed.model),
			expectView(role("button", { name: "Load more" })).toBeAbsent(),
		)
	})

	test("a failed next page keeps the events shown, and trying again asks from the same place", () => {
		const asked = pageUpdate(loaded(), Message.ClickedLoadMore()).model
		const failed = pageUpdate(asked, nextPage(asked, Result.fail(down))).model

		expect(eventsOf(failed)).toHaveLength(PAGE.events.length)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		expect(pageUpdate(failed, Message.ClickedLoadMore()).commands?.[0]).toMatchObject({
			name: NEXT_PAGE,
			args: { cursor: PAGE.nextCursor },
		})
	})

	// An empty answer to the old filters is not an answer to the new ones.
	test("an empty result does not stand in for the filters that are still loading", () => {
		const changed = routeChanged(
			loaded(noAuditEvents, { outcome: "denied" }),
			routeOf({ outcome: "success" }),
			context,
		)

		scene(
			{ update: pageUpdate, view },
			given(changed.model),
			expectView(role("button", { name: "Clear filters" })).toExist(),
			expectView(text("No events match these filters")).toBeAbsent(),
			expectView(text("No audit events yet")).toBeAbsent(),
		)
	})

	test("a Maple event's id opens the same entry in the Settings audit log", () => {
		const model = loaded()
		const first = eventsOf(model)?.[0]
		const opened = pageUpdate(model, Message.ToggledEvent({ id: first?.id ?? "" })).model

		scene(
			{ update: pageUpdate, view },
			given(opened),
			expectView(role("link", { name: first?.providerEventId ?? "" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.Settings({ search: { tab: "audit-log", entry: first?.providerEventId } })),
			),
		)
	})

	test("an empty log says what will show up; an empty filter result offers to clear the filters", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(noAuditEvents)),
			expectView(text("No audit events yet")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(noAuditEvents, { outcome: "denied" })),
			expectView(text("No audit events yet")).toBeAbsent(),
			expectView(role("button", { name: "Clear filters" })).toExist(),
		)
	})
})
