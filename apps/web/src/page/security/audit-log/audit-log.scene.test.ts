import { OrgId } from "@maple/domain"
import { AuditTrailPersistenceError } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Result, Schema, Array as Arr, String as Str } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { auditEventsOf, noAuditEvents } from "../../../lab/security-audit-log-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { PageContext } from "../../contract"
import { eventsOf } from "./derive"
import { type EventsPage, Message, type Model, type Search } from "./model"
import { init, routeChanged, update } from "./update"
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

const routeOf = (search: Search = {}) => AppRoute.SecurityAuditLog({ search })
const ADMIN = Policy.allPermissions
const ENGINEER = Policy.grantsOf(["org:engineer"])

const fold = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) => () =>
	Message.CompletedReadGrants({ orgId: context.orgId, grants: [...grants] })

const firstPage = (page: EventsPage) => (model: Model) =>
	Message.CompletedFetchFirstPage({ key: model.firstPage.key ?? "", result: Result.succeed(page) })

/** The page as an admin sees it once the first page answered. */
const loaded = (page: EventsPage = auditEventsOf(NOW), search: Search = {}): Model =>
	fold(init(routeOf(search), context).model, [
		() => Message.ReadClock({ nowMs: NOW }),
		grantsRead(ADMIN),
		firstPage(page),
	])

const nextPage = (model: Model, page: EventsPage, generation = model.laterPages.generation) =>
	Message.CompletedFetchNextPage({
		key: model.laterPages.key ?? "",
		generation,
		result: Result.succeed(page),
	})

/** A second page: the same events a day older, under other ids. */
const olderPage = (hasMore: boolean): EventsPage => {
	const page = auditEventsOf(NOW - 3 * 24 * 3600 * 1000, hasMore)
	return {
		...page,
		events: Arr.map(page.events, (event) => ({ ...event, id: `f${Str.slice(1)(event.id)}` })),
	}
}

describe("security audit log", () => {
	test("an engineer is told the log is for admins and nothing is asked of the API", () => {
		const entered = init(routeOf(), context)
		const answered = pageUpdate(entered.model, grantsRead(ENGINEER)())

		expect(names(answered.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(text("Only org admins can read the audit log.")).toExist(),
			expectView(role("table", { name: "Audit events" })).toBeAbsent(),
		)
	})

	test("an admin's first page is asked for once, whichever of the session and the page comes first", () => {
		const entered = init(routeOf(), context)
		const answered = pageUpdate(entered.model, grantsRead(ADMIN)())

		expect(
			Arr.filter(
				[...names(entered.commands), ...names(answered.commands)],
				(name) => name === "SecurityApiAuditLogFirstPage",
			),
		).toHaveLength(1)
	})

	test("lists who did what, marks a refusal and groups the events by day", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("table", { name: "Audit events" })).toExist(),
			expectView(text("Ada Lovelace")).toExist(),
			expectView(text("alert_rule.updated")).toExist(),
			expectView(text("Denied")).toExist(),
			expectView(text("Today")).toExist(),
			expectView(role("button", { name: "Load more" })).toExist(),
		)
	})

	test("opening an event shows what the platform recorded about it", () => {
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
			loaded(auditEventsOf(NOW), { outcome: "denied", category: "credential" }),
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

	test("new filters in the URL read the list again and start the later pages over", () => {
		const model = loaded()
		const withMore = fold(pageUpdate(model, Message.ClickedLoadMore()).model, [
			(current) => nextPage(current, olderPage(true)),
		])
		const changed = routeChanged(withMore, routeOf({ outcome: "denied" }), context)

		expect(names(changed.commands)).toEqual(["SecurityApiAuditLogFirstPage"])
		expect(changed.model.laterPages.pages).toEqual([])
	})

	test("load more continues from the last event shown and appends what comes back", () => {
		const model = loaded()
		const asked = pageUpdate(model, Message.ClickedLoadMore())
		const last = Arr.last(auditEventsOf(NOW).events)

		expect(asked.commands?.[0]).toMatchObject({
			name: "SecurityApiAuditLogNextPage",
			args: { cursor: last._tag === "Some" ? `${last.value.occurredAt}:${last.value.id}` : "" },
		})
		const appended = pageUpdate(asked.model, nextPage(asked.model, olderPage(false))).model
		expect(eventsOf(appended)).toHaveLength(16)
		scene(
			{ update: pageUpdate, view },
			given(appended),
			expectView(role("button", { name: "Load more" })).toBeAbsent(),
		)
	})

	test("a page that answers after the filters changed is dropped", () => {
		const asked = pageUpdate(loaded(), Message.ClickedLoadMore()).model
		const stale = pageUpdate(
			asked,
			nextPage(asked, olderPage(true), asked.laterPages.generation - 1),
		).model

		expect(eventsOf(stale)).toHaveLength(8)
	})

	test("a failed next page keeps the events shown and offers to try again", () => {
		const asked = pageUpdate(loaded(), Message.ClickedLoadMore()).model
		const failed = pageUpdate(
			asked,
			Message.CompletedFetchNextPage({
				key: asked.laterPages.key ?? "",
				generation: asked.laterPages.generation,
				result: Result.fail(
					toLoadFailure(
						new AuditTrailPersistenceError({ message: "The audit trail could not be read" }),
					),
				),
			}),
		).model

		expect(eventsOf(failed)).toHaveLength(8)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(role("button", { name: "Try again" })).toExist(),
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
