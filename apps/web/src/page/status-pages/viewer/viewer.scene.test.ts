import { OrgId } from "@maple/domain"
import { StatusPagePublicId } from "@maple/domain/http/v2"
import { makeSnapshot } from "@maple/status-page/fixtures"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, selector, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../contract"
import { ORG } from "../../kit/alert-test-rows"
import { pageId } from "../shared/test-pages"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as viewerView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const viewerUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(viewerView, { context })()

const entered = () =>
	init({ _tag: "StatusPageView", pageId: Schema.encodeSync(StatusPagePublicId)(pageId(1)) }, context)

describe("status page viewer", () => {
	test("reads the page as visitors see it and draws it in the sandboxed frame, whose web links open a new tab", () => {
		const start = entered()
		expect(Arr.map(start.commands ?? [], ({ name }) => name)).toEqual(["FetchStatusPageView"])
		const snapshot = makeSnapshot()
		const internal = { ...snapshot, page: { ...snapshot.page, visibility: "internal" as const } }
		const loaded = viewerUpdate(
			start.model,
			Message.CompletedFetchView({
				key: start.model.snapshot.key ?? "",
				result: Result.succeed(internal),
			}),
		).model
		scene(
			{ update: viewerUpdate, view },
			given(loaded),
			expectView(text("Only members of this organization can read this page.")).toExist(),
			expectView(selector('iframe[title="Acme status"]')).toHaveAttr(
				"sandbox",
				"allow-scripts allow-popups allow-popups-to-escape-sandbox",
			),
		)
	})

	test("an id that is not a page id, or a page that is gone, is not found, with a way back", () => {
		const bad = init({ _tag: "StatusPageView", pageId: "nope" }, context)
		expect(bad.commands ?? []).toEqual([])
		const start = entered()
		const gone = viewerUpdate(
			start.model,
			Message.CompletedFetchView({
				key: start.model.snapshot.key ?? "",
				result: Result.fail({ ...toLoadFailure(new Error("gone")), code: "status_page_not_found" }),
			}),
		).model
		for (const model of [bad.model, gone])
			scene(
				{ update: viewerUpdate, view },
				given(model),
				expectView(text("Status page not found")).toExist(),
				expectView(role("link", { name: "Back to status pages" })).toHaveAttr(
					"href",
					"/status-pages",
				),
				expectView(role("button", { name: "Try again" })).not.toExist(),
			)
	})

	test("a failed read offers Try again", () => {
		const start = entered()
		const failed = viewerUpdate(
			start.model,
			Message.CompletedFetchView({
				key: start.model.snapshot.key ?? "",
				result: Result.fail(toLoadFailure(new Error("unavailable"))),
			}),
		).model
		scene(
			{ update: viewerUpdate, view },
			given(failed),
			expectView(text("Couldn't load the status page")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
	})
})
