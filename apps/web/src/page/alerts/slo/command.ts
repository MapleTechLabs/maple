import { SloId } from "@maple/domain"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import { deleteSlo, retrieveSlo, setSloAlerting, sloHistory, sloStatus } from "../shared/slo-commands"
import { Message } from "./message"

export const ReadSloClock = Command.define("ReadSloClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchSloSession = Command.define("FetchSloSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ orgId, grants })),
})

export const FetchSlo = Command.define("FetchSlo", {
	args: { key: Schema.String, sloId: SloId },
	messages: [Message.CompletedFetchSlo],
	execute: ({ key, sloId }) =>
		retrieveSlo(sloId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSlo({ key, result })),
		),
})

export const FetchSloStatus = Command.define("FetchSloStatus", {
	args: { key: Schema.String, sloId: SloId },
	messages: [Message.CompletedFetchStatus],
	execute: ({ key, sloId }) =>
		sloStatus(sloId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchStatus({ key, result })),
		),
})

export const FetchSloHistory = Command.define("FetchSloHistory", {
	args: { key: Schema.String, sloId: SloId },
	messages: [Message.CompletedFetchHistory],
	execute: ({ key, sloId }) =>
		sloHistory(sloId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchHistory({ key, result })),
		),
})

export const ToggleSloAlerting = Command.define("ToggleSloAlerting", {
	args: { sloId: SloId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggleAlerting],
	execute: ({ sloId, enabled }) =>
		setSloAlerting(sloId, enabled).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedToggleAlerting({ result })),
		),
})

export const DeleteSlo = Command.define("DeleteSlo", {
	args: { sloId: SloId },
	messages: [Message.CompletedDelete],
	execute: ({ sloId }) =>
		deleteSlo(sloId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDelete({ result })),
		),
})
