import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Array as Arr, DateTime, Effect, Option, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../../page/contract"
import { Message } from "../../page/dashboards/view/message"
import { Model } from "../../page/dashboards/view/model"
import { ShareMessage, type ShareRow } from "../../page/dashboards/view/share"
import { openShare } from "../../page/dashboards/view/share-update"
import { init as pageInit, update as pageUpdate } from "../../page/dashboards/view/update"
import { shareDialog } from "../../page/dashboards/view/view-share"
import { defineLabWithFlags } from "../define"
import { keepLocal } from "../local-commands"

// `/lab/dashboard-share`: the dashboard's Share dialog, open over fixtures (`?state=`):
// not shared, shared with no expiry, a link that expires, and one that already has.

const LabState = Schema.Literals(["off", "shared", "expiring", "expired"])
type LabState = typeof LabState.Type
const Flags = Schema.Struct({ state: LabState })
type Flags = typeof Flags.Type

const CONTEXT: PageContext = { orgId: OrgId.make("lab"), pinnedNamespace: null, timeZone: "UTC" }
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-19T12:00:00.000Z"))
const DAY_MS = 24 * 60 * 60 * 1000
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

const DOCUMENT = Schema.decodeSync(DashboardDocument)({
	id: "dash_lab_share",
	name: "Checkout health",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	createdAt: "2026-11-01T12:00:00.000Z",
	updatedAt: "2026-11-18T12:00:00.000Z",
	schemaVersion: 3,
})

const sharesFor = (state: LabState): ReadonlyArray<ShareRow> => {
	const board = { widgetId: null, mode: "public" as const, token: "mshr_lab_7Qm2c9VxR4tL" }
	switch (state) {
		case "off":
			return []
		case "shared":
			return [board]
		case "expiring":
			return [{ ...board, expiresAt: isoAt(NOW_MS + 7 * DAY_MS) }]
		case "expired":
			return [{ ...board, expiresAt: isoAt(NOW_MS - DAY_MS) }]
	}
}

const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "expiring",
	),
}))

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, CONTEXT)
	return { model: next.model, commands: keepLocal(next.commands) }
}

const step = (model: Model, message: Message) => pageUpdate(model, message, CONTEXT).model

const init = (flags: Flags) => {
	const booted = Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId: CONTEXT.orgId, grants: Policy.allPermissions }),
			Message.CompletedReadClock({ nowMs: NOW_MS }),
			Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some(DOCUMENT) }),
			Message.GotShareMessage({ message: ShareMessage.GotOrigin({ origin: "https://app.maple.dev" }) }),
		],
		pageInit({ dashboardId: DOCUMENT.id, search: {} }, CONTEXT).model,
		step,
	)
	// Answers the list read the page sent last, so it is not dropped as stale.
	const loaded = step(
		booted,
		Message.GotShareMessage({
			message: ShareMessage.CompletedFetchShares({
				seq: booted.sharing.fetchSeq,
				result: Result.succeed(sharesFor(flags.state)),
			}),
		}),
	)
	const opened = openShare(loaded)
	return { model: opened.model, commands: keepLocal(opened.commands) }
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => shareDialog(h, model, CONTEXT)

export const lab = defineLabWithFlags("Dashboard share", {
	Model,
	Flags,
	flags,
	init,
	update,
	view,
	devTools: { Message },
})
