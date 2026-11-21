import { statusPageOrgKey } from "@maple/domain/status-page"
import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { NOW, ORG } from "../../kit/alert-test-rows"
import { makeComponent, makeSnapshot } from "@maple/status-page/fixtures"
import type { V2StatusPage, V2StatusPageIncident } from "@maple/domain/http/v2"
import { docsUrl } from "../../kit/docs"
import { newStatusPageHref, statusPageHref, statusPageViewHref } from "../shared/commands"
import { PageOutMessage } from "../../contract"
import { type StatusPageSummary, summarizePage } from "../shared/derive"
import { monitorHref } from "../../kit/uptime/commands"
import { monitorId } from "../../kit/uptime/test-monitors"
import { incident, pageId, statusPage } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as listView } from "./view"

const KEY = statusPageOrgKey(ORG)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const listUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(listView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const entered = (canEdit = true): Model => {
	const start = init({ _tag: "StatusPages" }, context).model
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants: canEdit ? ENGINEER : MEMBER }),
		],
		start,
		(model, message) => listUpdate(model, message).model,
	)
}

const summaryOf = (
	page: V2StatusPage,
	snapshot: Parameters<typeof makeSnapshot>[0] = {},
	incidents: ReadonlyArray<V2StatusPageIncident> = [],
): StatusPageSummary => summarizePage({ page, snapshot: makeSnapshot(snapshot), incidents })

const withPages = (pages: ReadonlyArray<StatusPageSummary>, canEdit = true): Model => {
	const model = entered(canEdit)
	return listUpdate(
		model,
		Message.CompletedFetchPages({ key: model.pages.key ?? "", result: Result.succeed(pages) }),
	).model
}

describe("status pages list", () => {
	test("entering reads the pages and the session", () => {
		const sent = names(init({ _tag: "StatusPages" }, context).commands)
		expect(sent).toContain("FetchStatusPageSummaries")
		expect(sent).toContain("FetchStatusPagesSession")
	})

	test("an org without pages gets the builder as its on-ramp; members see it locked, with who can", () => {
		scene(
			{ update: listUpdate, view },
			given(withPages([])),
			expectView(text("No status pages yet")).toExist(),
			expectView(role("link", { name: "Create a status page" })).toHaveAttr(
				"href",
				newStatusPageHref(),
			),
			expectView(role("link", { name: "How status pages work" })).toHaveAttr(
				"href",
				docsUrl("statusPages"),
			),
		)
		scene(
			{ update: listUpdate, view },
			given(withPages([], false)),
			expectView(role("link", { name: "Create a status page" })).not.toExist(),
			expectView(role("button", { name: "Create a status page" })).toBeDisabled(),
			expectView(
				role("group", { name: "Only org admins and engineers can edit status pages." }),
			).toExist(),
		)
	})

	test("each card says who can view the page; an internal one has no public address", () => {
		scene(
			{ update: listUpdate, view },
			given(
				withPages([
					summaryOf(statusPage({ visibility: "password", has_password: true })),
					summaryOf(statusPage({ id: pageId(2), slug: "acme-internal", visibility: "internal" })),
				]),
			),
			expectView(text("Password")).toExist(),
			expectView(text("Internal")).toExist(),
			expectView(text("Members only, in Maple")).toExist(),
			expectView(text(`/s/${KEY}/acme-internal`)).not.toExist(),
		)
	})

	test("a card shows the page's status, each component's status and uptime, and links into the editor", () => {
		const page = statusPage({ published_at: null })
		const live = summaryOf(page, {
			components: [
				makeComponent(0, { name: "API", group: "Platform", status: "partial_outage" }),
				makeComponent(1, { name: "Docs", monitored: false, days: [] }),
			],
		})
		scene(
			{ update: listUpdate, view },
			given(withPages([live, summaryOf(statusPage({ id: pageId(2), name: "Internal", draft: true }))])),
			expectView(role("link", { name: "Acme Status" })).toHaveAttr("href", statusPageHref(page.id)),
			expectView(text(`/s/${KEY}/acme-status`)).toExist(),
			expectView(text("Partial outage")).toExist(),
			expectView(text("Platform")).toExist(),
			expectView(role("img", { name: "API: 100.00% over the last 90 days" })).toExist(),
			expectView(text("No monitor: set by hand")).toExist(),
			expectView(text("Not published")).toExist(),
			expectView(text("Draft")).toExist(),
			expectView(role("link", { name: "New status page" })).toHaveAttr("href", newStatusPageHref()),
			expectView(role("button", { name: "Actions for Acme Status" })).toExist(),
		)
	})

	test("a monitored component opens its uptime monitor; a hand-set one links nowhere", () => {
		const snapshot = makeSnapshot({
			components: [
				makeComponent(0, { name: "API" }),
				makeComponent(1, { name: "Docs", monitored: false, days: [] }),
			],
		})
		const summary = summarizePage({
			page: statusPage(),
			snapshot,
			incidents: [],
			components: [
				{ id: snapshot.components[0]!.id, monitor_id: monitorId(1) },
				{ id: snapshot.components[1]!.id, monitor_id: null },
			],
		})
		scene(
			{ update: listUpdate, view },
			given(withPages([summary])),
			expectView(role("link", { name: /^API/ })).toHaveAttr("href", monitorHref(monitorId(1))),
			expectView(role("link", { name: /^Docs/ })).not.toExist(),
		)
	})

	test("open incidents and the next maintenance link to their tabs; a draft says so", () => {
		const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
		const summary = summaryOf(statusPage(), {}, [
			incident(1, { title: "Elevated API errors" }),
			incident(2, { title: "Slow search", published: false }),
			incident(3, {
				kind: "maintenance",
				status: "scheduled",
				title: "Database upgrade",
				scheduled_start: at(24),
				scheduled_end: at(26),
				published: false,
			}),
		])
		scene(
			{ update: listUpdate, view },
			given(withPages([summary])),
			expectView(role("link", { name: "Elevated API errors" })).toHaveAttr(
				"href",
				statusPageHref(summary.page.id, "incidents"),
			),
			expectView(text("+1 more incident")).toExist(),
			expectView(text("Next maintenance")).toExist(),
			expectView(role("link", { name: "Database upgrade" })).toHaveAttr(
				"href",
				statusPageHref(summary.page.id, "maintenance"),
			),
			expectView(text("Draft")).toExist(),
		)
	})

	test("a page without components points to where they are added", () => {
		const summary = summaryOf(statusPage(), { components: [] })
		scene(
			{ update: listUpdate, view },
			given(withPages([summary])),
			expectView(text("No components yet")).toExist(),
			expectView(role("link", { name: "Add components" })).toHaveAttr(
				"href",
				statusPageHref(summary.page.id, "settings", "monitors"),
			),
		)
	})

	test("members get no New status page button", () => {
		scene(
			{ update: listUpdate, view },
			given(withPages([summaryOf(statusPage())], false)),
			expectView(role("link", { name: "New status page" })).not.toExist(),
		)
	})

	test("a failed read offers a retry that reads again", () => {
		const model = entered()
		const failed = listUpdate(
			model,
			Message.CompletedFetchPages({
				key: model.pages.key ?? "",
				result: Result.fail(toLoadFailure(new Error("down"))),
			}),
		).model
		scene(
			{ update: listUpdate, view },
			given(failed),
			expectView(text("Couldn't load status pages")).toExist(),
		)
		expect(names(listUpdate(failed, Message.ClickedRetry()).commands)).toEqual([
			"FetchStatusPageSummaries",
		])
	})
})

describe("status page card menu", () => {
	const pick = (model: Model, id: ReturnType<typeof pageId>, value: string) =>
		listUpdate(
			model,
			Message.GotRowMenuMessage({
				pageId: id,
				message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } },
			}),
		)

	test("Edit opens the editor", () => {
		const model = withPages([summaryOf(statusPage())])
		expect(pick(model, pageId(1), "edit").outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: statusPageHref(pageId(1)), isReplace: false }),
		)
	})

	test("the menu opens the dev preview; an internal or draft page has no public page to open", () => {
		for (const page of [
			statusPage({ visibility: "internal" }),
			statusPage({ draft: true, published_at: null }),
		]) {
			const model = withPages([summaryOf(page)])
			expect(names(pick(model, pageId(1), "open-public").commands)).not.toContain(
				"OpenStatusPageInNewTab",
			)
			expect(pick(model, pageId(1), "open-preview").outMessage).toEqual(
				PageOutMessage.RequestedNavigation({ url: statusPageViewHref(pageId(1)), isReplace: false }),
			)
		}
	})

	test("the card has no open buttons; a member still gets the menu to open the page", () => {
		scene(
			{ update: listUpdate, view },
			given(withPages([summaryOf(statusPage({ visibility: "internal" }))], false)),
			expectView(role("link", { name: /Open dev preview/u })).not.toExist(),
			expectView(role("button", { name: /Open public page/u })).not.toExist(),
			expectView(role("button", { name: "Actions for Acme Status" })).toExist(),
		)
	})

	test("Delete asks first, then deletes, toasts and reads the list again", () => {
		const asked = pick(withPages([summaryOf(statusPage())]), pageId(1), "delete")
		expect(names(asked.commands)).not.toContain("DeleteListedStatusPage")
		expect(asked.model.deletingPageId).toBe(pageId(1))
		const confirming = listUpdate(asked.model, Message.ClickedConfirmDelete())
		expect(confirming.commands?.[0]).toMatchObject({
			name: "DeleteListedStatusPage",
			args: { pageId: pageId(1) },
		})
		const done = listUpdate(
			confirming.model,
			Message.CompletedDelete({ result: Result.succeed(undefined) }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Status page deleted", description: "" }),
		)
		expect(names(done.commands)).toContain("FetchStatusPageSummaries")
		expect(done.model.isDeleting).toBe(false)
	})

	test("members cannot delete from the menu", () => {
		const asked = pick(withPages([summaryOf(statusPage())], false), pageId(1), "delete")
		expect(asked.model.deletingPageId).toBeNull()
		expect(names(asked.commands)).not.toContain("DeleteListedStatusPage")
	})
})
