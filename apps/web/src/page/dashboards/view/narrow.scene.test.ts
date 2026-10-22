import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { slotOf } from "./plan"
import { init, update } from "./update"

// A list on a board wider than the list cap offers "Show last 7 days" for that tile alone.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_wide",
	name: "Wide",
	timeRange: { type: "relative", value: "30d" },
	widgets: [
		{
			id: "logs",
			visualization: "list",
			dataSource: { kind: "route", endpoint: "list_logs", params: { limit: 50 } },
			display: { title: "Recent logs" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const revealed = (): Model =>
	[
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		Message.RevealedWidget({ widgetId: "logs" }),
	].reduce(
		(model, message) => pageUpdate(model, message).model,
		init({ dashboardId: "dash_wide", search: {} }, context).model,
	)

describe("a list wider than the cap", () => {
	test("is blocked until narrowed, then asks for the capped window", () => {
		expect(slotOf(revealed(), "logs").gate?._tag).toBe("Range")
		const narrowed = pageUpdate(revealed(), Message.ClickedNarrowRange({ widgetId: "logs" }))
		const gate = slotOf(narrowed.model, "logs").gate
		expect(gate?._tag).toBe("Request")
		expect((narrowed.commands ?? []).map(({ name }) => name)).toContain(FetchWidget.name)
		const params = gate?._tag === "Request" ? gate.request.params : {}
		expect([params["startTime"], params["endTime"]]).toEqual([
			"2026-09-24 12:00:00",
			"2026-10-01 12:00:00",
		])
	})
})
