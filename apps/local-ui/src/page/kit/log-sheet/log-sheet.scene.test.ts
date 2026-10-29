import * as Animation from "@foldkit/ui/animation"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import * as Tooltip from "@maple/web/ui/tooltip"
import {
	click,
	Command,
	expect as expectView,
	given,
	hover,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LogSheetBlock } from "./block"
import { Message } from "./message"
import type { LocalLog } from "./model"
import { isOpen } from "./update"
import { view as sheetView } from "./view"

const log = (severityText: string, logAttributes: Record<string, string> = {}): LocalLog => ({
	timestamp: "2026-10-01 11:59:30.000000000",
	severityText,
	severityNumber: 0,
	serviceName: "payment-svc",
	body: "pool exhausted",
	traceId: "0eab694ff33721d5a836ce7444afadcc",
	spanId: "1111111111111111",
	recordIdentity: "1",
	logAttributes,
	resourceAttributes: {},
})

const RECT = { left: 0, right: 80, top: 0, bottom: 32, width: 80, height: 32 }
const mounted = [
	Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
	Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect: RECT })),
] as const
const { update } = LogSheetBlock
const openLog = (entry: LocalLog) => LogSheetBlock.init(entry)
const view = withViewInputs(sheetView, { timeFormat: { locale: "en-US", timeZone: "UTC" } })()

describe("log detail sheet", () => {
	test("an ERROR log shows the error banner with the exception message and type", () => {
		const opened = openLog(
			log("ERROR", { "exception.message": "timeout after 30s", "exception.type": "PoolTimeout" }),
		)
		expect(isOpen(opened.model)).toBe(true)
		scene(
			{ update, view },
			given(opened.model),
			...mounted,
			expectView(text("timeout after 30s")).toExist(),
			expectView(text("PoolTimeout")).toExist(),
			expectView(role("button", { name: "Copy error message" })).toExist(),
		)
	})

	test("an INFO log has no banner", () => {
		scene(
			{ update, view },
			given(openLog(log("INFO")).model),
			...mounted,
			expectView(role("button", { name: "Copy error message" })).not.toExist(),
		)
	})

	test("resting on the Log JSON copy button opens its tooltip", () => {
		scene(
			{ update, view },
			given(openLog(log("INFO")).model),
			...mounted,
			hover(role("button", { name: "Copy Log JSON" })),
			Command.resolve(Tooltip.WaitOpenDelay, Tooltip.Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.test.WaitForPaint,
				Animation.AnimationBlock.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.test.WaitForAnimationSettled,
				Animation.AnimationBlock.Message.EndedAnimation({ generation: 1 }),
			),
			expectView(text("Copy Log JSON")).toExist(),
		)
	})

	test("the close button closes it; reopening on the same log keeps its expansion", () => {
		const opened = openLog(log("ERROR"))
		const expanded = update(opened.model, Message.ToggledBodyExpanded()).model
		const closed = update(expanded, Message.ClosedSheet()).model
		expect(isOpen(closed)).toBe(false)
		const reopened = LogSheetBlock.operations.requestShowLog(closed, { log: log("ERROR") }).model
		expect([isOpen(reopened), reopened.isBodyExpanded]).toEqual([true, true])
	})

	test("a tooltip open when the sheet closed is closed when it reopens", () => {
		const opened = openLog(log("INFO")).model
		const hovering = { ...opened, tooltip: { ...opened.tooltip, isOpen: true } }
		const closed = update(hovering, Message.ClosedSheet()).model
		expect(
			LogSheetBlock.operations.requestShowLog(closed, { log: log("INFO") }).model.tooltip.isOpen,
		).toBe(false)
	})

	test("showing a log without a trace drops the Trace tab and keeps the selected tab", () => {
		const opened = openLog(log("INFO")).model
		const shown = LogSheetBlock.operations.requestShowLog(opened, {
			log: { ...log("INFO"), traceId: "", recordIdentity: "2" },
		}).model
		expect([shown.tabs.values, shown.tabs.selected]).toEqual([["attributes", "raw"], "attributes"])
	})

	test("a megabyte JSON body previews its head and, expanded, shows a capped part with a note", () => {
		const body = JSON.stringify(
			Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`key${i}`, { status: 500 }])),
		)
		scene(
			{ update, view },
			given(openLog({ ...log("INFO"), body }).model),
			...mounted,
			expectView(text(/"key0"/)).toExist(),
			expectView(text(/"key19999"/)).not.toExist(),
			click(role("button", { name: /Show full message/ })),
			expectView(text(/Showing the first .* Copy it to get all of it\./)).toExist(),
			expectView(text(/"key19999"/)).not.toExist(),
			expectView(role("button", { name: "Copy message" })).toExist(),
		)
	})
})
