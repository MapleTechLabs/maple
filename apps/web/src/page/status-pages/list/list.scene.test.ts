import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { StatusPagesDisabledError } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { NOW, ORG } from "../../kit/alert-test-rows"
import { newStatusPageHref, statusPageHref, statusPageViewHref } from "../shared/commands"
import { PageOutMessage } from "../../contract"
import type { StatusPageSummary } from "../shared/derive"
import { pageId, statusPage } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, rowMenuId, update } from "./update"
import { view as listView } from "./view"

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

	test("an org without pages gets the builder as its on-ramp; members are told who can", () => {
		scene(
			{ update: listUpdate, view },
			given(withPages([])),
			expectView(text("No status pages yet")).toExist(),
			expectView(role("link", { name: "Create a status page" })).toHaveAttr(
				"href",
				newStatusPageHref(),
			),
		)
		scene(
			{ update: listUpdate, view },
			given(withPages([], false)),
			expectView(role("link", { name: "Create a status page" })).not.toExist(),
			expectView(text("Ask an org admin to create one.")).toExist(),
		)
	})

	test("each row says who can view the page; an internal one has no public address", () => {
		const row = (page: ReturnType<typeof statusPage>): StatusPageSummary => ({
			page,
			overall: "operational",
			componentCount: 1,
			openIncidents: 0,
		})
		scene(
			{ update: listUpdate, view },
			given(
				withPages([
					row(statusPage({ visibility: "password", has_password: true })),
					row(statusPage({ id: pageId(2), slug: "acme-internal", visibility: "internal" })),
				]),
			),
			expectView(text("Password")).toExist(),
			expectView(text("Internal")).toExist(),
			expectView(text("Members only, in Maple")).toExist(),
			expectView(text("/s/acme-internal")).not.toExist(),
		)
	})

	test("a row shows the name, address, status, open incidents and publish state; drafts say so", () => {
		const live: StatusPageSummary = {
			page: statusPage({ published_at: null }),
			overall: "partial_outage",
			componentCount: 3,
			openIncidents: 2,
		}
		const draft: StatusPageSummary = {
			page: statusPage({
				id: pageId(2),
				name: "Internal",
				slug: "acme-internal",
				draft: true,
				published_at: null,
			}),
			overall: "operational",
			componentCount: 1,
			openIncidents: 0,
		}
		scene(
			{ update: listUpdate, view },
			given(withPages([live, draft])),
			expectView(role("link", { name: "Acme Status" })).toHaveAttr(
				"href",
				statusPageHref(live.page.id),
			),
			expectView(text("/s/acme-status")).toExist(),
			expectView(text("Partial outage")).toExist(),
			expectView(text("2")).toExist(),
			expectView(text("Not published")).toExist(),
			expectView(text("Draft")).toExist(),
			expectView(role("link", { name: "New status page" })).toHaveAttr("href", newStatusPageHref()),
		)
	})

	test("members get no New status page button", () => {
		scene(
			{ update: listUpdate, view },
			given(
				withPages(
					[{ page: statusPage(), overall: "operational", componentCount: 1, openIncidents: 0 }],
					false,
				),
			),
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

	test("an org outside the rollout is told so, not shown a failed load", () => {
		const model = entered()
		const refused = listUpdate(
			model,
			Message.CompletedFetchPages({
				key: model.pages.key ?? "",
				result: Result.fail(
					toLoadFailure(
						new StatusPagesDisabledError({
							message: "Status pages are not enabled for this organization.",
						}),
					),
				),
			}),
		).model
		scene(
			{ update: listUpdate, view },
			given(refused),
			expectView(text("Status pages are not enabled")).toExist(),
			expectView(text("Couldn't load status pages")).not.toExist(),
			// Neither helps until the org is in the rollout.
			expectView(role("button", { name: "Try again" })).not.toExist(),
			expectView(role("link", { name: "Create a status page" })).not.toExist(),
		)
	})
})

describe("status pages row menu", () => {
	const summary = (fields: Parameters<typeof statusPage>[0] = {}): StatusPageSummary => ({
		page: statusPage(fields),
		overall: "operational",
		componentCount: 1,
		openIncidents: 0,
	})
	const pick = (model: Model, id: ReturnType<typeof pageId>, value: string) =>
		listUpdate(
			model,
			Message.GotRowMenuMessage({
				pageId: id,
				message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value } },
			}),
		)

	test("each row has an actions menu", () => {
		scene(
			{ update: listUpdate, view },
			given(withPages([summary()])),
			expectView(role("button", { name: "Actions for Acme Status" })).toExist(),
		)
	})

	test("Edit opens the editor; Open page opens an internal page in Maple", () => {
		const model = withPages([summary({ visibility: "internal" })])
		expect(pick(model, pageId(1), "edit").outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: statusPageHref(pageId(1)), isReplace: false }),
		)
		expect(pick(model, pageId(1), "open").outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: statusPageViewHref(pageId(1)), isReplace: false }),
		)
	})

	test("Delete asks first, then deletes, toasts and reads the list again", () => {
		const asked = pick(withPages([summary()]), pageId(1), "delete")
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
		const asked = pick(withPages([summary()], false), pageId(1), "delete")
		expect(asked.model.deletingPageId).toBeNull()
		expect(asked.model.rowMenus[rowMenuId(pageId(1))]).toBeDefined()
	})
})
