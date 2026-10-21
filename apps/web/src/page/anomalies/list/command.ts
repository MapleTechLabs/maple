import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message } from "./message"
import { StatusTab } from "./model"

// v2 lists cap at 100; further pages arrive through the explicit "Load more".
export const INCIDENTS_PAGE_LIMIT = 100

/** `listQuery`: every status but "all" filters server-side. */
export const listQueryOf = (status: StatusTab) =>
	status === "all" ? { limit: INCIDENTS_PAGE_LIMIT } : { status, limit: INCIDENTS_PAGE_LIMIT }

const fetchPage = (status: StatusTab, cursor: string | undefined) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const page = yield* client.anomalies.listIncidents({
			query: { ...listQueryOf(status), ...(cursor === undefined ? undefined : { cursor }) },
		})
		return { data: page.data, nextCursor: page.next_cursor }
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `scrollIntoView(id)`: the focused row, nearest edge, smoothly. Ids are read off the rows. */
export const ScrollIncidentIntoView = Command.define("ScrollAnomalyIncidentIntoView", {
	args: { incidentId: Schema.String },
	messages: [Message.CompletedScrollRow],
	execute: ({ incidentId }) =>
		Effect.sync(() => {
			Array.from(document.querySelectorAll<HTMLElement>("[data-incident-id]"))
				.find((row) => row.getAttribute("data-incident-id") === incidentId)
				?.scrollIntoView({ block: "nearest", behavior: "smooth" })
			return Message.CompletedScrollRow()
		}),
})

export const ReadAnomaliesClock = Command.define("ReadAnomaliesClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchFirstPage = Command.define("FetchAnomalyIncidents", {
	args: { key: Schema.String, status: StatusTab },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, status }) =>
		Effect.map(fetchPage(status, undefined), (result) => Message.CompletedFetchFirstPage({ key, result })),
})

export const LoadMoreIncidents = Command.define("LoadMoreAnomalyIncidents", {
	args: { status: StatusTab, cursor: Schema.String },
	messages: [Message.CompletedLoadMore],
	execute: ({ status, cursor }) =>
		Effect.map(fetchPage(status, cursor), (result) => Message.CompletedLoadMore({ status, cursor, result })),
})

export const LoadSignalPresence = Command.define("LoadAnomaliesSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
