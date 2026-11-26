import * as Policy from "@maple/domain/policy"
import { encodePublicId, PublicIdPrefixes, V2RetentionPolicy } from "@maple/domain/http/v2"
import { Array as Arr, Clock, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as RetentionModel from "../page/settings/retention/model"
import * as RetentionUpdate from "../page/settings/retention/update"
import * as RetentionView from "../page/settings/retention/view"
import type { Resources } from "../platform/resources"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { keepLocal } from "./local-commands"

// `/lab/retention`: the settings Retention tab over fixtures. `?state=` picks a start: as stored, a
// shorter or longer period picked, a member who cannot edit, no source overrides, loading, a failed read.

export const LabState = Schema.Literals([
	"stored",
	"shorter",
	"longer",
	"member",
	"no-sources",
	"own-warehouse",
	"loading",
	"error",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState, nowMs: Schema.Number })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
	const nowMs = yield* Clock.currentTimeMillis
	return {
		nowMs,
		state: Option.getOrElse(
			Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
			(): LabState => "stored",
		),
	}
})

export const Model = Schema.Struct({ nowMs: Schema.Number, retention: RetentionModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotRetentionMessage: { message: RetentionModel.Message } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const DEFAULTS = { traces: 30, logs: 30, metrics: 90, sessions: 30, events: 365, profiles: 14 }
const NOTHING_SET = { traces: null, logs: null, metrics: null, sessions: null, events: null, profiles: null }
const CHECKOUT = "4f0d7c2e-8a51-4b6e-9c1d-2a7e5b3f9d10"
const STAGING = "9b2c4d6e-1f3a-4c5b-8d7e-0a1b2c3d4e5f"

const policy = (withSources: boolean, storage: "managed" | "own_warehouse" = "managed") =>
	Schema.decodeSync(V2RetentionPolicy)({
		object: "retention_policy",
		storage,
		periods: [3, 7, 14, 30, 60, 90, 180, 365, 730],
		defaults: DEFAULTS,
		organization: { set: { ...NOTHING_SET, logs: 90 }, days: { ...DEFAULTS, logs: 90 } },
		read_horizon_days: { ...DEFAULTS, logs: withSources ? 180 : 90 },
		sources: withSources
			? [
					{
						source_id: encodePublicId(PublicIdPrefixes.source, CHECKOUT),
						set: { ...NOTHING_SET, logs: 180 },
						days: { ...DEFAULTS, logs: 180 },
					},
					{
						source_id: encodePublicId(PublicIdPrefixes.source, STAGING),
						set: { ...NOTHING_SET, traces: 7, logs: 7 },
						days: { ...DEFAULTS, traces: 7, logs: 7 },
					},
				]
			: [],
	})

const ADMIN = Policy.grantsOf(["org:admin"])
const MEMBER = Policy.grantsOf(["org:member"])

const step = (model: RetentionModel.Model, message: RetentionModel.Message): RetentionModel.Model =>
	RetentionUpdate.update(model, message).model

export const init = (flags: Flags): Return => {
	const start = RetentionUpdate.init(flags.state === "member" ? MEMBER : ADMIN).model
	const answers: ReadonlyArray<RetentionModel.Message> =
		flags.state === "loading"
			? []
			: flags.state === "error"
				? [
						RetentionModel.Message.CompletedFetchPolicy({
							result: Result.fail(
								toLoadFailure("Retention settings are temporarily unavailable."),
							),
						}),
					]
				: [
						RetentionModel.Message.CompletedFetchPolicy({
							result: Result.succeed(
								policy(
									flags.state !== "no-sources",
									flags.state === "own-warehouse" ? "own_warehouse" : "managed",
								),
							),
						}),
						RetentionModel.Message.CompletedFetchSources({
							result: Result.succeed([
								{ id: CHECKOUT, name: "checkout-api" },
								{ id: STAGING, name: "staging" },
							]),
						}),
						...(flags.state === "shorter"
							? [RetentionModel.Message.ChangedPeriod({ signal: "logs", value: "14" })]
							: flags.state === "longer"
								? [
										RetentionModel.Message.ChangedPeriod({
											signal: "traces",
											value: "90",
										}),
										RetentionModel.Message.ChangedPeriod({
											signal: "sessions",
											value: "7",
										}),
									]
								: []),
						RetentionModel.Message.ReadClock({ nowMs: flags.nowMs }),
					]
	return { model: { nowMs: flags.nowMs, retention: Arr.reduce(answers, start, step) } }
}

/** Kit commands run; every API read and write is dropped. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotRetentionMessage: ({ message: child }) => {
			const next = RetentionUpdate.update(model.retention, child)
			return {
				model: { ...model, retention: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotRetentionMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Retention" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto w-full max-w-4xl space-y-4 p-6")],
		[
			h.submodel({
				slotId: "lab-retention",
				model: model.retention,
				view: RetentionView.view,
				viewInputs: { timeZone: "UTC", canOpenDataPlatform: true },
				toParentMessage: (message: RetentionModel.Message) =>
					Message.GotRetentionMessage({ message }),
			}),
		],
	)
