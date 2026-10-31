import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { NOW, ORG } from "../../alerts/shared/test-rows"
import { newStatusPageHref, statusPageHref } from "../shared/commands"
import type { StatusPageSummary } from "../shared/derive"
import { statusPage } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as listView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const listUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(listView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const entered = (isAdmin = true): Model => {
	const start = init({ _tag: "StatusPages" }, context).model
	return [Message.ReadClock({ nowMs: NOW }), Message.CompletedFetchSession({ orgId: ORG, isAdmin })].reduce(
		(model, message) => listUpdate(model, message).model,
		start,
	)
}

const withPages = (pages: ReadonlyArray<StatusPageSummary>, isAdmin = true): Model => {
	const model = entered(isAdmin)
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

	test("a row shows the name, address, status, open incidents and publish state; drafts say so", () => {
		const live: StatusPageSummary = {
			page: statusPage({ published_at: null }),
			overall: "partial_outage",
			componentCount: 3,
			openIncidents: 2,
		}
		const draft: StatusPageSummary = {
			page: statusPage({ name: "Internal", slug: "acme-internal", draft: true, published_at: null }),
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
})
