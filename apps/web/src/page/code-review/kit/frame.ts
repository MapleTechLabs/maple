import { GithubIntegrationStatus, VcsRepositoryId } from "@maple/domain/http"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Select from "../../../ui/select"
import type { PageOutMessage } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The state every Code Review tab with filters shares: the repository select, the author or
// workflow select, the window and Reload.

export const ALL = "all"

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

export const Frame = Schema.Struct({
	repoSelect: Select.Model,
	/** Authors (Analytics, Pull requests, Issues) or workflows (CI). */
	optionSelect: Select.Model,
	timePicker: TimeRangePicker.Model,
	/** `integrations.githubStatus`: the repository select's options. */
	githubStatus: Keyed.KeyedSchema(GithubIntegrationStatus, LoadFailure),
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Frame = typeof Frame.Type

export const FrameMessage = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchGithubStatus: {
		key: Schema.String,
		result: Schema.Result(GithubIntegrationStatus, LoadFailure),
	},
	GotRepoSelectMessage: { message: Select.Message },
	GotOptionSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	ClickedResetTimeRange: {},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
})
export type FrameMessage = typeof FrameMessage.Type

/** The URL's window params, as the filters read and write them. */
export type WindowSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** What a frame Message asks of the page. */
export type FrameOut =
	| Readonly<{ _tag: "PickedRepository"; repo: VcsRepositoryId | undefined }>
	| Readonly<{ _tag: "PickedOption"; value: string | undefined }>
	| Readonly<{ _tag: "PickedWindow"; window: WindowSearch }>
	/** The picker refused a range wider than the page allows: its error toast. */
	| Readonly<{ _tag: "RefusedWindow"; toast: PageOutMessage }>
	| Readonly<{ _tag: "ResolvedWindow"; window: TimeWindow; mode: RequestMode }>

export type FrameCommand = Command.Command<FrameMessage, never, Resources>

export type FrameReturn = Readonly<{
	frame: Frame
	commands: ReadonlyArray<FrameCommand>
	out: FrameOut | null
}>

// COMMANDS

export const ResolveWindow = Command.define("ResolveCodeReviewWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [FrameMessage.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			FrameMessage.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

export const FetchGithubStatus = Command.define("FetchCodeReviewGithubStatus", {
	args: { key: Schema.String },
	messages: [FrameMessage.CompletedFetchGithubStatus],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.githubStatus()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => FrameMessage.CompletedFetchGithubStatus({ key, result })),
		),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteCodeReviewReloadSpin", {
	args: { version: Schema.Number },
	messages: [FrameMessage.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), FrameMessage.CompletedReloadSpin({ version })),
})
