import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { Result } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import * as Tabs from "../../../ui/tabs"
import { init, Message, OutMessage, open, update, view } from "./index"
import type { Model } from "./model"
import { contextKeyOf, mergeLogContext } from "./panels"
import { CenterContextRow } from "./view-panels"

const log: LogRecord = {
	timestamp: "2026-10-01T11:59:59.023Z",
	exactTimestamp: "2026-10-01 11:59:59.023412000",
	severityText: "INFO",
	severityNumber: 9,
	serviceName: "storefront",
	body: "POST /api/checkout 200 785ms",
	traceId: undefined,
	spanId: undefined,
	logAttributes: { "http.route": "/api/checkout" },
	resourceAttributes: { "cloud.region": "us-east-1" },
}

const opened = (): Model => open(init("log-detail"), log, "org_test").model
const sceneView = withViewInputs(view, { timeZone: "UTC" })()
const program = { update, view: sceneView }

const RECT = { left: 16, right: 420, top: 4, bottom: 5, width: 122, height: 32 }
const mounted = [
	Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
	Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect: RECT })),
]

describe("log detail sheet", () => {
	test("opening shows the hero message, the meta strip and the Attributes tab", () => {
		scene(
			program,
			given(opened()),
			...mounted,
			expectView(role("dialog")).toExist(),
			expectView(text("POST /api/checkout 200 785ms", { exact: false })).toExist(),
			expectView(text("Oct 1, 11:59:59.023 AM")).toExist(),
			expectView(role("tab", { name: /Attributes/ })).toHaveAttr("aria-selected", "true"),
			expectView(text("Log Attributes")).toExist(),
		)
	})

	test("Close emits Closed", () => {
		const closed = update(opened(), Message.GotDialogMessage({ message: Dialog.Message.ClickedClose() }))
		expect(closed.outMessage).toEqual(OutMessage.Closed())
		expect(closed.model.dialog.isOpen).toBe(false)
	})

	test("an attribute's Filter action emits the attribute filter", () => {
		scene(
			program,
			given(opened()),
			...mounted,
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

	test("tabs follow the log: Trace only with a trace, Raw always", () => {
		expect(opened().tabs.values).toEqual(["attributes", "context", "raw"])
		const shown = update(opened(), Message.ClickedShowFullMessage())
		expect(shown.model.isHeroExpanded).toBe(true)
	})

	test("the Context tab reads each side once and lists the log between its neighbours", () => {
		const onContext = update(
			opened(),
			Message.GotTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) }),
		)
		expect(onContext.commands?.length).toBe(2)
		const again = update(
			onContext.model,
			Message.GotTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) }),
		)
		expect(again.commands ?? []).toEqual([])
		const before = { ...log, timestamp: "2026-10-01T11:59:58.000Z", exactTimestamp: "a", body: "before" }
		const after = { ...log, timestamp: "2026-10-01T12:00:01.000Z", exactTimestamp: "b", body: "after" }
		const beforeKey = contextKeyOf(onContext.model, log, "before") ?? ""
		const afterKey = contextKeyOf(onContext.model, log, "after") ?? ""
		const answered = [
			Message.CompletedFetchContext({
				key: beforeKey,
				side: "before",
				result: Result.succeed([log, before]),
			}),
			Message.CompletedFetchContext({
				key: afterKey,
				side: "after",
				result: Result.succeed([log, after]),
			}),
		].reduce((model, message) => update(model, message).model, onContext.model)
		scene(
			program,
			given(answered),
			...mounted,
			Mount.resolve(CenterContextRow, Message.PositionedLogRow()),
			expectView(text("Surrounding logs", { exact: false })).toExist(),
			expectView(role("button", { name: /before/ })).toExist(),
		)
		expect(mergeLogContext(log, [log, before], [log, after]).map((row) => row.body)).toEqual([
			"before",
			log.body,
			"after",
		])
	})

	test("picking a surrounding log shows it and keeps the tab", () => {
		const onContext = update(
			opened(),
			Message.GotTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) }),
		)
		const other = { ...log, body: "GET /health 200", exactTimestamp: "c" }
		const picked = update(onContext.model, Message.ClickedLog({ log: other }))
		expect(picked.model.log?.body).toBe("GET /health 200")
		expect(picked.model.tabs.selected).toBe("context")
		expect(picked.commands?.length).toBe(2)
	})

	test("an error log gets the error banner with its exception type", () => {
		const failing: LogRecord = {
			...log,
			severityText: "ERROR",
			severityNumber: 17,
			logAttributes: { "exception.type": "TimeoutError", "exception.message": "upstream timed out" },
		}
		scene(
			program,
			given(open(init("log-detail"), failing, "org_test").model),
			...mounted,
			expectView(text("TimeoutError")).toExist(),
			expectView(role("button", { name: "Copy error message" })).toExist(),
		)
	})
})
