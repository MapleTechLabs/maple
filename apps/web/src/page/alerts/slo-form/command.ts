import { SloId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { trackProduct } from "../../../data/analytics"
import { recentServiceNames } from "../shared/services"
import { retrieveSlo, saveSlo } from "../shared/slo-commands"
import { Message } from "./message"
import { fetchSessionGrants } from "../../kit/session-grants"

export const FetchExistingSlo = Command.define("FetchSloFormSlo", {
	args: { key: Schema.String, sloId: SloId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key, sloId }) =>
		retrieveSlo(sloId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExisting({ key, result })),
		),
})

/** The services traced in the last day: the ones an SLO can count. Empty on failure. */
export const FetchSloFormServices = Command.define("FetchSloFormServices", {
	messages: [Message.CompletedFetchServices],
	execute: Effect.map(recentServiceNames, (services) => Message.CompletedFetchServices({ services })),
})

export const FetchSloFormSession = fetchSessionGrants("FetchSloFormSession", Message.CompletedFetchSession)

export const SaveSloDraft = Command.define("SaveSloDraft", {
	args: { editingId: Schema.NullOr(SloId), payload: Schema.Unknown },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		saveSlo(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})

/** A created SLO is the `slo_created` product event. */
export const TrackSloCreated = Command.define("TrackSloCreated", {
	messages: [Message.CompletedTrackCreated],
	execute: trackProduct("slo_created").pipe(Effect.as(Message.CompletedTrackCreated())),
})
