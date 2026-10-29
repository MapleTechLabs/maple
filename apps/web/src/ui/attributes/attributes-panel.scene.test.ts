import type { HtmlBuilder } from "foldkit/html"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	placeholder,
	role,
	scene,
	text,
	type,
} from "foldkit/scene"
import * as Story from "foldkit/story"
import { describe, expect, test } from "vitest"
import { Message, type Model, OutMessage, WaitAttributeCopyStatus, WriteAttributeClipboard } from "./attributes-panel"
import { AttributesPanelBlock } from "./attributes-panel-block"
import { type PanelInputs, view } from "./attributes-view"

const { init, update } = AttributesPanelBlock
const { story } = Story

const INPUTS: PanelInputs = {
	logAttributes: { "http.route": "/api/checkout", duration_ms: "785", maple_org_id: "org_1" },
	resourceAttributes: { "cloud.region": "us-east-1", "k8s.pod.name": "storefront-1" },
	canFilter: true,
}

const program = {
	update: (model: Model, message: Message) => update(model, message),
	view: (model: Model, h: HtmlBuilder<Message>) => view(model, INPUTS, h),
}

describe("attributes panel", () => {
	test("rows group by namespace and the search narrows them", () => {
		scene(
			program,
			given(init("panel").model),
			expectView(text("route")).toExist(),
			expectView(text("pod.name")).toExist(),
			type(placeholder("Search attributes…"), "region"),
			expectView(text("region")).toExist(),
			expectView(text("pod.name")).not.toExist(),
			expectView(text('No log attributes match "region"', { exact: false })).toExist(),
		)
	})

	test("Maple's own keys wait in a closed section", () => {
		scene(
			program,
			given(init("panel").model),
			expectView(text("maple_org_id")).not.toExist(),
			click(role("button", { name: /^Maple internal/ })),
			expectView(text("maple_org_id")).toExist(),
		)
	})

	test("a row's Filter action reports the attribute filter", () => {
		scene(
			program,
			given(init("panel").model),
			click(role("button", { name: "Filter by http.route = /api/checkout" })),
			expectOutMessage(
				OutMessage.ChoseAttributeFilter({
					source: "log",
					key: "http.route",
					value: "/api/checkout",
					negated: false,
				}),
			),
		)
	})

	test("copying a key settles its status for that control only", () => {
		story(
			update,
			Story.given(init("panel").model),
			Story.message(Message.ClickedCopy({ copyId: "key:log:http.route", text: "x" })),
			Story.Command.expectHas(WriteAttributeClipboard),
			Story.Command.resolve(WriteAttributeClipboard, Message.SucceededCopy({ generation: 1 })),
			Story.model((model: Model) =>
				expect(model.copy).toEqual({ id: "key:log:http.route", status: "copied", generation: 1 }),
			),
			Story.Command.expectHas(WaitAttributeCopyStatus),
			Story.Command.resolve(WaitAttributeCopyStatus, Message.ElapsedCopyStatus({ generation: 0 })),
			Story.model((model: Model) => expect(model.copy.status).toBe("copied")),
		)
	})

	test("a JSON attribute previews raw, has no Filter action, and expands on click", () => {
		const jsonProgram = {
			update: program.update,
			view: (model: Model, h: HtmlBuilder<Message>) =>
				view(model, { ...INPUTS, logAttributes: { payload: '{"a":1,"b":[2]}' } }, h),
		}
		scene(
			jsonProgram,
			given(init("panel").model),
			expectView(text('{"a":1,"b":[2]}')).toExist(),
			expectView(role("button", { name: /^Filter by payload/ })).not.toExist(),
			click(text('{"a":1,"b":[2]}')),
			expectView(text("JSON")).toExist(),
			expectView(text('{"a":1,"b":[2]}')).not.toExist(),
		)
	})

	test("a huge JSON attribute expands to a capped part with a note", () => {
		const huge = JSON.stringify(
			Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`key${i}`, i])),
		)
		const hugeProgram = {
			update: program.update,
			view: (model: Model, h: HtmlBuilder<Message>) =>
				view(model, { ...INPUTS, logAttributes: { payload: huge } }, h),
		}
		scene(
			hugeProgram,
			given(init("panel").model),
			click(text(/^\{"key0":0/)),
			expectView(text(/Showing the first .* characters\. Copy it to get all of it\./)).toExist(),
			expectView(text(/"key19999"/)).not.toExist(),
		)
	})
})
