import { DashboardId } from "@maple/domain/http"
import { displayError } from "@maple/web-data/lib/error-messages"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"
import { ShareMessage, ShareWrite } from "./share"

// The share dialogs' effects: the page origin their links are built on, and the share writes.

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)
const wrap = (message: ShareMessage) => Message.GotShareMessage({ message })

export const ReadOrigin = Command.define("ReadDashboardShareOrigin", {
	messages: [Message.GotShareMessage],
	execute: Effect.sync(() => wrap(ShareMessage.GotOrigin({ origin: window.location.origin }))),
})

/** One share write; the list re-reads after each, as every mutation's reactivity key does. */
export const WriteShare = Command.define("WriteDashboardShare", {
	args: { dashboardId: Schema.String, write: ShareWrite },
	messages: [Message.GotShareMessage],
	execute: ({ dashboardId, write }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const chart = (widgetId: string) => ({ params: { id, widget_id: widgetId } })
			switch (write._tag) {
				case "SetBoardMode":
					if (write.access === "off") yield* client.dashboards.revokeShare({ params: { id } })
					else yield* client.dashboards.upsertShare({ params: { id }, payload: { mode: write.access } })
					return
				case "RotateBoard":
					yield* client.dashboards.rotateShare({ params: { id } })
					return
				case "RotateChart":
					yield* client.dashboards.rotateWidgetShare(chart(write.widgetId))
					return
				case "MintChart":
					yield* client.dashboards.upsertWidgetShare({ ...chart(write.widgetId), payload: { mode: "public" } })
					return
			}
		}).pipe(
			Effect.match({
				onFailure: (error) => wrap(ShareMessage.CompletedWrite({ error: displayError(error).message })),
				onSuccess: () => wrap(ShareMessage.CompletedWrite({ error: null })),
			}),
		),
})
