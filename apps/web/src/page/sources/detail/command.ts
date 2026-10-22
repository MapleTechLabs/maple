import { SourceId } from "@maple/domain/primitives"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { baseKey } from "../../../data/keyed"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { V2SourceUpdateParams } from "@maple/domain/http/v2"
import { loadSources, loadSourceUsage } from "../kit/data"
import { ExpiryChoice, expiresAtOf } from "../kit/rules"
import { Message } from "./message"

const HOUR_MS = 3_600_000

export const ReadSourceClock = Command.define("ReadSourceClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchSourceList = Command.define("FetchSourceDetailList", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchList],
	execute: ({ key, refresh }) =>
		loadSources(baseKey(key), refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchList({ key, result })),
		),
})

export const FetchSourceUsage = Command.define("FetchSourceUsage", {
	args: { key: Schema.String, id: SourceId },
	messages: [Message.CompletedFetchUsage],
	execute: ({ key, id }) =>
		loadSourceUsage(key, id).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsage({ key, result })),
		),
})

const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result)

/** `pause({ until })`: `hours` from now, or `null` for until resumed. */
export const PauseSource = Command.define("PauseSource", {
	args: { id: SourceId, hours: Schema.NullOr(Schema.Number) },
	messages: [Message.CompletedPause],
	execute: ({ id, hours }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const until = hours === null ? null : new Date(now + hours * HOUR_MS).toISOString()
			const client = yield* MapleApiV2Client
			return yield* client.sources.pause({ params: { id }, payload: { until } })
		}).pipe(
			write,
			Effect.map((result) => Message.CompletedPause({ result })),
		),
})

export const ResumeSource = Command.define("ResumeSource", {
	args: { id: SourceId },
	messages: [Message.CompletedResume],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.resume({ params: { id } })).pipe(
			write,
			Effect.map((result) => Message.CompletedResume({ result })),
		),
})

export const RollSourceToken = Command.define("RollSourceToken", {
	args: { id: SourceId },
	messages: [Message.CompletedRoll],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.roll({ params: { id } })).pipe(
			write,
			Effect.map((result) => Message.CompletedRoll({ result })),
		),
})

export const DeleteSource = Command.define("DeleteSource", {
	args: { id: SourceId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.sources.delete({ params: { id } })).pipe(
			Effect.asVoid,
			write,
			Effect.map((result) => Message.CompletedDelete({ result })),
		),
})

/** `sources.update`; `expiry` adds `expires_at` only when it changes the stored one. */
export const SaveSource = Command.define("SaveSource", {
	args: { id: SourceId, payload: V2SourceUpdateParams, expiry: Schema.NullOr(ExpiryChoice) },
	messages: [Message.CompletedSave],
	execute: ({ id, payload, expiry }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const expiresAt = expiry === null ? undefined : expiresAtOf(expiry, nowMs)
			const client = yield* MapleApiV2Client
			return yield* client.sources.update({
				params: { id },
				payload: expiresAt === undefined ? payload : { ...payload, expires_at: expiresAt },
			})
		}).pipe(
			write,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})
