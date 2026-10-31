import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { currentWindow, TimeWindow } from "../../data/time-range"
import { MapleApiV2Client } from "../../platform/api-clients"
import { QuickStartState, readQuickStartState, writeQuickStartState } from "../onboarding/quick-start-state"
import { Message } from "./setup-checklist"

/** `quickStartAtomFamily(orgId)`: the stored progress, read once on entry. */
export const ReadSetupState = Command.define("ReadSetupChecklistState", {
	args: { storageKey: Schema.String },
	messages: [Message.ReadState],
	execute: ({ storageKey }) => Effect.map(readQuickStartState(storageKey), (state) => Message.ReadState({ state })),
})

export const SaveSetupState = Command.define("SaveSetupChecklistState", {
	args: { storageKey: Schema.String, state: QuickStartState },
	messages: [Message.CompletedSaveState],
	execute: ({ storageKey, state }) =>
		Effect.as(writeQuickStartState(storageKey, state), Message.CompletedSaveState()),
})

/** `retainedQueryV2("ingestKeys", "retrieve", {})`. */
export const FetchSetupKeys = Command.define("FetchSetupChecklistKeys", {
	messages: [Message.SucceededLoadKeys, Message.FailedLoadKeys],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.ingestKeys.retrieve()).pipe(
		Effect.map((keys) => Message.SucceededLoadKeys({ publicKey: keys.public_key, privateKey: keys.private_key })),
		Effect.orElseSucceed(() => Message.FailedLoadKeys()),
	),
})

/** `getServiceOverviewResultAtom({ data: { startTime, endTime } })`, the pin applied ("top"). */
export const FetchSetupOverview = Command.define("FetchSetupChecklistOverview", {
	args: { window: TimeWindow, pinnedNamespace: Schema.NullOr(Schema.String) },
	messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
	execute: ({ window, pinnedNamespace }) =>
		getServiceOverview({
			data: pinnedNamespace === null ? window : { ...window, namespaces: [pinnedNamespace] },
		}).pipe(
			Effect.map((response) =>
				Message.SucceededLoadOverview({
					window,
					services: response.data.map((row) => ({
						serviceName: String(row.serviceName),
						spanCount: row.spanCount ?? 0,
					})),
				}),
			),
			Effect.catch((error) =>
				Effect.succeed(Message.FailedLoadOverview({ window, failure: toLoadFailure(error) })),
			),
		),
})

/** Re-resolves the last hour against the clock, so each poll sees what landed since entry. */
export const ResolveSetupPollWindow = Command.define("ResolveSetupChecklistPollWindow", {
	args: { timeZone: Schema.String },
	messages: [Message.ResolvedPollWindow],
	execute: ({ timeZone }) =>
		Effect.map(currentWindow({ preset: "1h", snap: false, timeZone }), (window) =>
			Message.ResolvedPollWindow({ window }),
		),
})
