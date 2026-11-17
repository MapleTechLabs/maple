import { OrgId } from "@maple/domain"
import { StatusPagePublicId } from "@maple/domain/http/v2"
import { makeSnapshot } from "@maple/status-page/fixtures"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	attr,
	click,
	expect as expectView,
	find,
	given,
	inside,
	role,
	scene,
	selector,
	tap,
	text,
	withViewInputs,
} from "foldkit/scene"
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
			expectView(selector('maple-preview-frame[frame-title="Acme status"]')).toHaveAttr(
				"sandbox",
				"allow-scripts allow-popups allow-popups-to-escape-sandbox",
			),
			expectView(role("link", { name: "Close preview" })).toHaveAttr(
				"href",
				`/status-pages/${Schema.encodeSync(StatusPagePublicId)(pageId(1))}`,
			),
		)
	})

	test("the preview switches between example states, a phone width and, for an Auto page, light and dark", () => {
		const start = entered()
		const snapshot = makeSnapshot()
		const loadedWith = (appearance: "auto" | "light") =>
			viewerUpdate(
				start.model,
				Message.CompletedFetchView({
					key: start.model.snapshot.key ?? "",
					result: Result.succeed({
						...snapshot,
						page: { ...snapshot.page, theme: { ...snapshot.page.theme, appearance } },
					}),
				}),
			).model
		const iframeOf = find("maple-preview-frame")
		const srcdoc = (html: Parameters<typeof iframeOf>[0]): string =>
			Option.getOrElse(Option.flatMap(iframeOf(html), attr("srcdoc")), () => "")
		const pick = (group: string, name: string) =>
			inside(role("group", { name: group }), click(role("button", { name })))
		const note = text("Showing an example state. Visitors still see the live page.")
		scene(
			{ update: viewerUpdate, view },
			given(loadedWith("auto")),
			expectView(note).not.toExist(),
			tap(({ html }) => expect(srcdoc(html)).not.toContain("Example incident")),
			pick("Preview state", "Outage"),
			tap(({ html }) => expect(srcdoc(html)).toContain("Example incident")),
			expectView(note).toExist(),
			pick("Preview state", "Maintenance"),
			tap(({ html }) => expect(srcdoc(html)).toContain("Example maintenance")),
			pick("Preview width", "Mobile"),
			expectView(selector("maple-preview-frame")).toHaveAttr("data-width", "mobile"),
			expectView(role("group", { name: "Preview mode" })).toExist(),
		)
		scene(
			{ update: viewerUpdate, view },
			given(loadedWith("light")),
			expectView(role("group", { name: "Preview mode" })).not.toExist(),
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
