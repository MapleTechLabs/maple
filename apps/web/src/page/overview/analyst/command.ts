import { getErrorsByType } from "@maple/web-data/warehouse/errors"
import { Effect, Schema, Array as Arr } from "effect"
import { Command, Mount } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { readClock, reloadSpin } from "@maple/views/data/timing"
import { errorIssueFromV2 } from "../../../data/error-issues"
import { TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listSloRows } from "../../alerts/shared/slo-commands"
import { loadSignalPresences } from "../../kit/signal-presence"
import { listMonitors } from "../../kit/uptime/commands"
import { RANK_LIMIT, topErrorsOf } from "./derive"
import { Message } from "./message"

/** The page is in the DOM: the reads it has not started yet start now. */
export const MountAnalystHome = Mount.define("MountAnalystHome", {
	messages: [Message.Entered],
	execute: () => Effect.succeed(Message.Entered()),
})

export const ReadClock = readClock("ReadAnalystHomeClock", Message.CompletedReadClock)

/** Reload and a return to the page: the real clock, so every read is asked again. */
export const ResolveClock = readClock("ResolveAnalystHomeClock", Message.CompletedResolveClock)

export const CompleteReloadSpin = reloadSpin("CompleteAnalystHomeReloadSpin", Message.CompletedReloadSpin)

/** `uptimeMonitors.list`, the read the Uptime tab makes. */
export const FetchMonitors = Command.define("FetchAnalystHomeMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

/** `slos.list` with every status, the read the SLOs tab makes. */
export const FetchSlos = Command.define("FetchAnalystHomeSlos", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSlos],
	execute: ({ key }) =>
		listSloRows.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSlos({ key, result })),
		),
})

/**
 * The Errors page's volume sort: `getErrorsByType` ranks the window's fingerprints, then
 * `errorIssues.list` reads exactly those open issues.
 */
export const FetchTopErrors = Command.define("FetchAnalystHomeTopErrors", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchErrors],
	execute: ({ key, window }) =>
		Effect.gen(function* () {
			const ranked = yield* getErrorsByType({
				data: { startTime: window.startTime, endTime: window.endTime, limit: RANK_LIMIT },
			})
			if (ranked.data.length === 0) return []
			const client = yield* MapleApiV2Client
			const response = yield* client.errorIssues.list({
				query: {
					limit: RANK_LIMIT,
					state: "open",
					fingerprint_hash: Arr.join(
						Arr.map(ranked.data, (row) => row.fingerprintHash),
						",",
					),
				},
			})
			return topErrorsOf(Arr.map(response.data, errorIssueFromV2), ranked.data)
		}).pipe(settleTo((result) => Message.CompletedFetchErrors({ key, result }))),
})

export const LoadSignalPresence = Command.define("LoadAnalystHomeSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})
