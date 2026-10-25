import { V2SourceUpdateParams } from "@maple/domain/http/v2"
import { PushSourcePlatform, SourceId } from "@maple/domain/primitives"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { baseKey } from "../../../data/keyed"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { loadSource, loadSources } from "../kit/data"
import { ExpiryChoice, expiresAtOf } from "../kit/rules"
import { Message } from "./message"

/** A new step or source starts at the top; the scroll area otherwise keeps the old offset. */
export const ScrollToTop = Command.define("ScrollSourcesNewToTop", {
	messages: [Message.CompletedScrollToTop],
	execute: Effect.sync(() => {
		document.querySelector('[data-slot="page-scroll-area"]')?.scrollTo({ top: 0 })
		// Onboarding's drawer: the sheet panel's viewport around the flow.
		document
			.querySelector("[data-connect-flow-scroll]")
			?.closest('[data-slot="scroll-area-viewport"]')
			?.scrollTo({ top: 0 })
		return Message.CompletedScrollToTop()
	}),
})

/** `FirstDataStatus`'s `POLL_MS`. */
export const POLL_MS = 5_000

/** `sourcesListAtom`, read through the cache; a superseded key re-reads. */
export const FetchSourcesList = Command.define("FetchSourcesList", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchList],
	execute: ({ key, refresh }) =>
		loadSources(baseKey(key), refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchList({ key, result })),
		),
})

export const FetchCreatedSource = Command.define("FetchCreatedSource", {
	args: { key: Schema.String, id: SourceId, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchSource],
	execute: ({ key, id, refresh }) =>
		loadSource(baseKey(key), id, refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSource({ key, result })),
		),
})

/** `useIntervalRefresh(refresh, { intervalMs: POLL_MS })`: one tick. */
export const WaitFirstDataPoll = Command.define("WaitFirstDataPoll", {
	args: { key: Schema.String },
	messages: [Message.ElapsedPoll],
	execute: ({ key }) =>
		Effect.sleep(Duration.millis(POLL_MS)).pipe(Effect.as(Message.ElapsedPoll({ key }))),
})

/** `sources.create` with the rules payload; the expiry resolves against the clock at submit. */
export const CreateSource = Command.define("CreateSource", {
	args: {
		name: Schema.String,
		platform: PushSourcePlatform,
		rules: V2SourceUpdateParams,
		expiry: ExpiryChoice,
	},
	messages: [Message.CompletedCreate],
	execute: ({ name, platform, rules, expiry }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const client = yield* MapleApiV2Client
			return yield* client.sources.create({
				payload: { name, platform, ...rules, expires_at: expiresAtOf(expiry, nowMs) ?? null },
			})
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ result })),
		),
})
