import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, test } from "vitest"
import { shiftTimeline } from "./shift-timeline"

const Message = defineMessageUnion({ ClickedBar: {} })
type Message = typeof Message.Type
type Model = Readonly<{ nowMs: number }>

const HOUR = 3_600_000
const FROM = Date.parse("2026-11-09T00:00:00.000Z")

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	shiftTimeline(h, {
		fromMs: FROM,
		toMs: FROM + 7 * 24 * HOUR,
		timeZone: "UTC",
		nowMs: model.nowMs,
		ariaLabel: "Shifts",
		nowLabel: "Now, Tue 10 Nov, 11:30",
		rows: [
			{
				key: "final",
				label: "Final schedule",
				bars: [
					{
						key: "a",
						startMs: FROM,
						endMs: FROM + HOUR,
						label: "Ana",
						title: "Ana, 1 hour",
						tone: "primary",
						onClick: Message.ClickedBar(),
					},
				],
			},
			{
				key: "layer",
				label: "Primary",
				bars: [
					{
						key: "b",
						startMs: FROM,
						endMs: FROM + 24 * HOUR,
						label: "Ben",
						title: "Ben, Mon",
						tone: "neutral",
					},
				],
			},
		],
	})
const update = (model: Model) => ({ model, commands: [] })

describe("shift timeline", () => {
	test("reads as a table: day column headers, a row header per lane, and every bar named", () => {
		scene(
			{ update, view },
			given<Model>({ nowMs: FROM + 35 * HOUR }),
			expectView(role("columnheader", { name: "Mon 9" })).toExist(),
			expectView(role("rowheader", { name: /Primary/u })).toExist(),
			expectView(role("button", { name: "Ana, 1 hour" })).toExist(),
			expectView(role("img", { name: "Ben, Mon" })).toExist(),
			expectView(text("Now, Tue 10 Nov, 11:30")).toExist(),
		)
	})

	test("says nothing of now when it is outside the range", () => {
		scene(
			{ update, view },
			given<Model>({ nowMs: FROM - HOUR }),
			expectView(text("Now, Tue 10 Nov, 11:30")).not.toExist(),
		)
	})
})
