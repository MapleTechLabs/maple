import { Option } from "effect"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { Message } from "./message"
import type { LocalLog } from "./model"
import { isOpen, openLog, update } from "./update"
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
const view = withViewInputs(sheetView, { timeFormat: { locale: "en-US", timeZone: "UTC" } })()

describe("log detail sheet", () => {
	test("an ERROR log shows the error banner with the exception message and type", () => {
		const opened = openLog(Option.none(), log("ERROR", { "exception.message": "timeout after 30s", "exception.type": "PoolTimeout" }))
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
		scene({ update, view }, given(openLog(Option.none(), log("INFO")).model), ...mounted, expectView(role("button", { name: "Copy error message" })).not.toExist())
	})

	test("the close button closes it; reopening on the same log keeps its expansion", () => {
		const opened = openLog(Option.none(), log("ERROR"))
		const expanded = update(opened.model, Message.ToggledBodyExpanded()).model
		const closed = update(expanded, Message.ClosedSheet()).model
		expect(isOpen(closed)).toBe(false)
		const reopened = openLog(Option.some(closed), log("ERROR")).model
		expect([isOpen(reopened), reopened.isBodyExpanded]).toEqual([true, true])
	})
})
