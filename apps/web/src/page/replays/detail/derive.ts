import { isSessionLive, sessionDurationMs } from "@maple/ui/lib/replay-format"
import { buildTimeline, parseChTimestampMs, type Timeline } from "../../../components/replays/replay-timeline"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { classifyUnplayable } from "../kit/replay-meta"
import { manifestDurationMs } from "../kit/replay-range"
import { recordedMarker, type ReplayPartitionWindow, replayPartitionWindow } from "../kit/replay-window"
import { chunksOf, neededFailure, seedEvents } from "./loader"
import type { LoadFailure } from "../../../data/load-failure"
import type { Model, ReplayDetail } from "./model"

export type PlayerStatus = "loading" | "error" | "empty" | "unrecorded" | "ready"

export const windowOf = (model: Model): ReplayPartitionWindow | undefined => replayPartitionWindow(model.search.t)

export const detailOf = (model: Model): ReplayDetail | undefined =>
	Option.getOrUndefined(Option.flatMap(AsyncData.getData(model.detail.data), Option.fromNullishOr))

const livenessOf = (session: ReplayDetail) => ({
	status: session.status,
	lastActivityAt: session.lastActivityAt,
	startTime: session.startTime,
	durationMs: session.durationMs,
})

export const isActive = (model: Model, session: ReplayDetail): boolean => isSessionLive(livenessOf(session), model.nowMs)

export const durationOf = (session: ReplayDetail): number | null => sessionDurationMs(livenessOf(session))

export const labelOf = (session: ReplayDetail): string =>
	session.userName || session.userEmail || session.userId || "Anonymous session"

/** The player's load status (`ReplayPlayerProvider`'s memo). */
export const playerStatus = (model: Model, session: ReplayDetail): { status: PlayerStatus; failure: LoadFailure | null } => {
	const recorded = recordedMarker(session.resourceAttributes)
	const sessionActive = isActive(model, session)
	const rangeFailure = AsyncData.isFailure(model.loader.range.data) && model.loader.queue.length > 0
	if (rangeFailure && model.loader.range.data._tag === "Failure")
		return { status: "error", failure: model.loader.range.data.error }
	const needed = neededFailure(model)
	if (needed !== null) return { status: "error", failure: needed }
	return AsyncData.matchData(model.manifest.data, {
		onEmpty: () => ({ status: "loading", failure: null }),
		onFailure: (failure) => ({ status: "error", failure }),
		onData: (manifest) => {
			const chunkCount = manifest.chunks.length
			if (chunkCount === 0)
				return { status: classifyUnplayable({ recorded, chunkCount, sessionActive }), failure: null }
			const seed = seedEvents(model.loader)
			if (seed.length >= 2) return { status: "ready", failure: null }
			return seed.length > 0
				? { status: classifyUnplayable({ recorded, chunkCount, sessionActive }), failure: null }
				: { status: "loading", failure: null }
		},
	})
}

export const manifestTotalMs = (model: Model): number => manifestDurationMs(chunksOf(model))

/** Real⇄display mapping: idle gaps collapse while skip-idle is on. */
export const timelineOf = (model: Model): Timeline =>
	buildTimeline(model.player.isSkippingIdle ? model.meta.inactiveIntervals : [], model.player.totalMs)

/** A warehouse timestamp as a real offset into the recording, clamped. */
export const realOffsetOf = (model: Model, timestamp: string): number | undefined => {
	const epoch = parseChTimestampMs(timestamp)
	if (Number.isNaN(epoch)) return undefined
	return Math.max(0, Math.min(epoch - model.meta.startTime, model.player.totalMs))
}
