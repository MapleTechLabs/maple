import { listHosts } from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { Message } from "./message"

/** `HOST_LIST_LIMIT`: the query orders by last seen, so past this the oldest hosts drop first. */
export const HOST_LIST_LIMIT = 1000

export const FetchHosts = Command.define("FetchInfraHosts", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchHosts],
	execute: ({ key, window }) =>
		listHosts({
			data: { startTime: window.startTime, endTime: window.endTime, limit: HOST_LIST_LIMIT },
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchHosts({ key, result })),
		),
})
