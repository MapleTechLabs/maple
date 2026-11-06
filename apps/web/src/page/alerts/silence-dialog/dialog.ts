import { V2AlertSilence, V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { Clock, DateTime, Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "@maple/views/ui/dialog"
import type { Resources } from "../../../platform/resources"
import { MAX_ALERT_SILENCE_DURATION_MS } from "@maple/domain/http"
import { createSilence } from "../shared/silences"

// "Silence notifications": the dialog the hub, a rule and an incident open, as one Submodel.

export const SilenceDuration = Schema.Literals(["1h", "4h", "morning", "custom"])
export type SilenceDuration = typeof SilenceDuration.Type

export const ScopeField = Schema.Literals(["services", "tags", "environments"])
export type ScopeField = typeof ScopeField.Type

/** What the silence covers: fixed by the page that opened it, or typed in (the hub's "New silence"). */
export const Scope = Schema.Union([
	Schema.TaggedStruct("Fixed", { label: Schema.String, matchers: V2AlertSilenceMatchers }),
	Schema.TaggedStruct("Typed", {
		services: Schema.String,
		tags: Schema.String,
		environments: Schema.String,
	}),
])
export type Scope = typeof Scope.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	scope: Scope,
	reason: Schema.String,
	duration: SilenceDuration,
	/** The custom end, as a `datetime-local` input holds it (`2026-11-06T18:30`), in `timeZone`. */
	until: Schema.String,
	timeZone: Schema.String,
	/** The wall clock when the dialog opened: a custom end is checked against it. */
	nowMs: Schema.Number,
	isSaving: Schema.Boolean,
	/** Bumped on every open: a save's result only settles the form it was sent from. */
	openCount: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	scope: { _tag: "Typed", services: "", tags: "", environments: "" },
	reason: "",
	duration: "1h",
	until: "",
	timeZone: "UTC",
	nowMs: 0,
	isSaving: false,
	openCount: 0,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedReason: { value: Schema.String },
	ChangedDuration: { duration: SilenceDuration },
	ChangedUntil: { value: Schema.String },
	ChangedScopeField: { field: ScopeField, value: Schema.String },
	ClickedCancel: {},
	ClickedSave: {},
	CompletedSave: { openCount: Schema.Number, result: Schema.Result(V2AlertSilence, Schema.String) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	CreatedSilence: { silence: V2AlertSilence },
	RequestedToast: {
		type: Schema.Literals(["success", "error"]),
		title: Schema.String,
		description: Schema.String,
	},
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const HOUR_MS = 60 * 60_000
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** A `datetime-local` value read as a wall clock in `timeZone`. */
export const parseLocalDateTime = (value: string, timeZone: string): Option.Option<number> => {
	const match = LOCAL_DATE_TIME.exec(value)
	if (match === null) return Option.none()
	const [year, month, day, hour, minute] = Arr.map(match.slice(1), Number)
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined
	)
		return Option.none()
	return Option.some(zonedPartsToEpochMs({ year, month, day, hour, minute, second: 0 }, timeZone))
}

/** When a silence picked at `nowMs` ends; none for a custom end that is missing, past, or over 30 days out. */
export const silenceEndMs = (
	duration: SilenceDuration,
	until: string,
	nowMs: number,
	timeZone: string,
): Option.Option<number> => {
	switch (duration) {
		case "1h":
			return Option.some(nowMs + HOUR_MS)
		case "4h":
			return Option.some(nowMs + 4 * HOUR_MS)
		case "morning": {
			// The next 09:00 on the viewer's wall clock: this morning's if it is still ahead.
			const today = zonedDateParts(nowMs, timeZone)
			const at = (day: number) =>
				zonedPartsToEpochMs({ ...today, day, hour: 9, minute: 0, second: 0 }, timeZone)
			return Option.some(at(today.day) > nowMs ? at(today.day) : at(today.day + 1))
		}
		case "custom":
			return Option.filter(
				parseLocalDateTime(until, timeZone),
				(endMs) => endMs > nowMs && endMs - nowMs <= MAX_ALERT_SILENCE_DURATION_MS,
			)
	}
}

const splitList = (value: string): ReadonlyArray<string> =>
	Arr.dedupe(Arr.filter(Arr.map(Str.split(value, ","), Str.trim), Str.isNonEmpty))

/** The matchers the form describes; empty matchers mean there is nothing to save yet. */
export const matchersOf = (scope: Scope): V2AlertSilenceMatchers => {
	if (scope._tag === "Fixed") return scope.matchers
	const services = splitList(scope.services)
	const tags = splitList(scope.tags)
	const environments = splitList(scope.environments)
	return {
		...(services.length === 0 ? undefined : { services }),
		...(tags.length === 0 ? undefined : { tags }),
		...(environments.length === 0 ? undefined : { environments }),
	}
}

const hasMatchers = (matchers: V2AlertSilenceMatchers) =>
	(matchers.rule_ids?.length ?? 0) +
		(matchers.services?.length ?? 0) +
		(matchers.tags?.length ?? 0) +
		(matchers.environments?.length ?? 0) >
	0

/** Why a typed custom end cannot be used, or none when it can (or nothing is typed yet). */
export const untilError = (model: Model): Option.Option<string> => {
	if (model.duration !== "custom" || model.until === "") return Option.none()
	return Option.match(parseLocalDateTime(model.until, model.timeZone), {
		onNone: () => Option.some("Pick a date and time"),
		onSome: (endMs) =>
			endMs <= model.nowMs
				? Option.some("Pick a time in the future")
				: endMs - model.nowMs > MAX_ALERT_SILENCE_DURATION_MS
					? Option.some("A silence can last at most 30 days")
					: Option.none(),
	})
}

/** Ready to save: a reason, something to match and an end that is ahead and within 30 days. */
export const isFormReady = (model: Model): boolean =>
	Str.isNonEmpty(Str.trim(model.reason)) &&
	hasMatchers(matchersOf(model.scope)) &&
	Option.isSome(silenceEndMs(model.duration, model.until, model.nowMs, model.timeZone))

// COMMANDS

export const SaveSilence = Command.define("SaveAlertSilence", {
	args: {
		openCount: Schema.Number,
		reason: Schema.String,
		matchers: V2AlertSilenceMatchers,
		duration: SilenceDuration,
		until: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedSave],
	execute: ({ openCount, reason, matchers, duration, until, timeZone }) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const endsAt = yield* Effect.fromOption(silenceEndMs(duration, until, nowMs, timeZone)).pipe(
				Effect.mapError(() => "Pick an end time in the future"),
			)
			return yield* createSilence({
				reason,
				matchers,
				ends_at: DateTime.formatIso(DateTime.makeUnsafe(endsAt)),
			}).pipe(Effect.mapError((failure) => failure.message))
		}).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, result })),
		),
})

// UPDATE

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

const open = (model: Model, scope: Scope, timeZone: string, nowMs: number): Return =>
	liftDialog(
		{
			...model,
			scope,
			timeZone,
			nowMs,
			reason: "",
			duration: "1h",
			until: "",
			isSaving: false,
			openCount: model.openCount + 1,
		},
		Dialog.open(model.dialog),
	)

/** Silence one rule, or one group of it: the scope is fixed and named in the dialog. */
export const openFor = (
	model: Model,
	target: { readonly label: string; readonly matchers: V2AlertSilenceMatchers },
	timeZone: string,
	nowMs: number,
): Return => open(model, { _tag: "Fixed", ...target }, timeZone, nowMs)

/** A silence the user scopes by service, tag and environment. */
export const openNew = (model: Model, timeZone: string, nowMs: number): Return =>
	open(model, { _tag: "Typed", services: "", tags: "", environments: "" }, timeZone, nowMs)

const save = (model: Model): Return =>
	model.isSaving || !isFormReady(model)
		? { model }
		: {
				model: { ...model, isSaving: true },
				commands: [
					SaveSilence({
						openCount: model.openCount,
						reason: Str.trim(model.reason),
						matchers: matchersOf(model.scope),
						duration: model.duration,
						until: model.until,
						timeZone: model.timeZone,
					}),
				],
			}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		ChangedReason: ({ value }) => ({ model: { ...model, reason: value } }),
		ChangedDuration: ({ duration }) => ({ model: { ...model, duration } }),
		ChangedUntil: ({ value }) => ({ model: { ...model, until: value } }),
		ChangedScopeField: ({ field, value }) =>
			model.scope._tag === "Fixed"
				? { model }
				: { model: { ...model, scope: { ...model.scope, [field]: value } } },
		ClickedCancel: () => liftDialog(model, Dialog.close(model.dialog)),
		ClickedSave: () => save(model),
		CompletedSave: ({ openCount, result }) =>
			Result.match(result, {
				onSuccess: (silence) => {
					const settled = { ...model, isSaving: false }
					const closed =
						openCount === model.openCount
							? liftDialog(settled, Dialog.close(model.dialog))
							: { model: settled }
					return { ...closed, outMessage: OutMessage.CreatedSilence({ silence }) }
				},
				onFailure: (failure) => ({
					model: { ...model, isSaving: false },
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: "Couldn't silence alerts",
						description: failure,
					}),
				}),
			}),
	})
