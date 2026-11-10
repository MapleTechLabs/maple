import { V2AlertSilence, V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { Clock, DateTime, Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import type { Resources } from "../../../platform/resources"
import { MAX_ALERT_SILENCE_DURATION_MS } from "@maple/domain/http"
import { shortZoneName } from "../../kit/timezone-zones"
import { hasMatchers, MatcherField } from "../shared/matcher-fields"
import { createSilence } from "../shared/silences"

// "Silence notifications": the side panel the hub, a rule and an incident open, as one Submodel.

export const SilenceDuration = Schema.Literals(["1h", "4h", "morning", "custom"])
export type SilenceDuration = typeof SilenceDuration.Type

export const ScopeField = MatcherField
export type ScopeField = MatcherField

const Chips = Schema.Array(Schema.String)

/** What the silence covers: fixed by the page that opened it, or picked as chips (the hub's "New silence"). */
export const Scope = Schema.Union([
	Schema.TaggedStruct("Fixed", { label: Schema.String, matchers: V2AlertSilenceMatchers }),
	Schema.TaggedStruct("Typed", { services: Chips, tags: Chips, environments: Chips }),
])
export type Scope = typeof Scope.Type

/** What each chips input offers before anything is typed: the names the org's rules already use. */
export type ScopeSuggestions = Readonly<Record<ScopeField, ReadonlyArray<string>>>

const NO_CHIPS: Extract<Scope, { readonly _tag: "Typed" }> = {
	_tag: "Typed",
	services: [],
	tags: [],
	environments: [],
}

/** One chips input per scope field; each field's chips live on the scope. */
const ScopeCombos = Schema.Struct({
	services: Combobox.Model,
	tags: Combobox.Model,
	environments: Combobox.Model,
})

const initCombos = (id: string): typeof ScopeCombos.Type => {
	const combo = (field: ScopeField) => Combobox.init(`${id}-${field}`, "multiple", { autoHighlight: true })
	return { services: combo("services"), tags: combo("tags"), environments: combo("environments") }
}

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	scope: Scope,
	combos: ScopeCombos,
	reason: Schema.String,
	duration: SilenceDuration,
	/** The custom end, as a `datetime-local` input holds it (`2026-11-06T18:30`), in `timeZone`. */
	until: Schema.String,
	timeZone: Schema.String,
	/** The wall clock when the dialog opened: a custom end is checked against it. */
	nowMs: Schema.Number,
	isSaving: Schema.Boolean,
	/** A save was tried on an incomplete form: each field left out says so. */
	isShowingErrors: Schema.Boolean,
	/** Bumped on every open: a save's result only settles the form it was sent from. */
	openCount: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "sheet"),
	scope: NO_CHIPS,
	combos: initCombos(id),
	reason: "",
	duration: "1h",
	until: "",
	timeZone: "UTC",
	nowMs: 0,
	isSaving: false,
	isShowingErrors: false,
	openCount: 0,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedReason: { value: Schema.String },
	ChangedDuration: { duration: SilenceDuration },
	ChangedUntil: { value: Schema.String },
	GotScopeComboMessage: { field: ScopeField, message: Combobox.Message },
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

/** The matchers the form describes; a field without chips is left out, and none mean nothing to save yet. */
export const matchersOf = (scope: Scope): V2AlertSilenceMatchers =>
	scope._tag === "Fixed"
		? scope.matchers
		: {
				...(scope.services.length === 0 ? undefined : { services: scope.services }),
				...(scope.tags.length === 0 ? undefined : { tags: scope.tags }),
				...(scope.environments.length === 0 ? undefined : { environments: scope.environments }),
			}

/** The zone the custom end is read in, as the viewer knows it at that end ("CET", then "CEST" past the change). */
export const endZoneLabel = (model: Pick<Model, "until" | "timeZone" | "nowMs">): string =>
	shortZoneName(
		model.timeZone,
		Option.getOrElse(parseLocalDateTime(model.until, model.timeZone), () => model.nowMs),
	)

/** Why a typed custom end cannot be used, or none when it can; an empty one waits for a tried save. */
export const untilError = (model: Model): Option.Option<string> => {
	if (model.duration !== "custom") return Option.none()
	if (model.until === "") return model.isShowingErrors ? Option.some("Pick a date and time") : Option.none()
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

/** A silence always says why: the reason shows on its row and on the pages it covers. */
export const reasonError = (reason: string): Option.Option<string> =>
	Str.isEmpty(Str.trim(reason)) ? Option.some("Add a reason") : Option.none()

export const scopeError = (scope: Scope): Option.Option<string> =>
	hasMatchers(matchersOf(scope))
		? Option.none()
		: Option.some("Add at least one service, environment or tag")

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
			combos: initCombos(model.dialog.id),
			timeZone,
			nowMs,
			reason: "",
			duration: "1h",
			until: "",
			isSaving: false,
			isShowingErrors: false,
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
	open(model, NO_CHIPS, timeZone, nowMs)

/** A chips input's step: its popup state stays on the combo, a changed selection lands on the scope. */
const scopeComboStep = (model: Model, field: ScopeField, message: Combobox.Message): Return => {
	if (model.scope._tag === "Fixed") return { model }
	const step = Combobox.update({ ...model.combos[field], selected: model.scope[field] }, message)
	const scope =
		step.outMessage?._tag === "ChangedSelection"
			? { ...model.scope, [field]: step.outMessage.selected }
			: model.scope
	return {
		model: { ...model, scope, combos: { ...model.combos, [field]: step.model } },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotScopeComboMessage({ field, message: inner }),
		),
	}
}

/** Closes the panel, as Cancel does; a page whose URL holds it closes it on Back. */
export const close = (model: Model): Return => liftDialog(model, Dialog.close(model.dialog))

const save = (model: Model): Return => {
	if (model.isSaving) return { model }
	// An incomplete form stays open and names what is missing, as the other alert forms do.
	if (!isFormReady(model)) return { model: { ...model, isShowingErrors: true } }
	return {
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
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) => liftDialog(model, Dialog.update(model.dialog, child)),
		ChangedReason: ({ value }) => ({ model: { ...model, reason: value } }),
		ChangedDuration: ({ duration }) => ({ model: { ...model, duration } }),
		ChangedUntil: ({ value }) => ({ model: { ...model, until: value } }),
		GotScopeComboMessage: ({ field, message: child }) => scopeComboStep(model, field, child),
		ClickedCancel: () => close(model),
		ClickedSave: () => save(model),
		CompletedSave: ({ openCount, result }) =>
			Result.match(result, {
				onSuccess: (silence) => {
					// A result from an earlier open still refreshes the list, but leaves this form alone.
					const closed =
						openCount === model.openCount
							? liftDialog({ ...model, isSaving: false }, Dialog.close(model.dialog))
							: { model }
					return { ...closed, outMessage: OutMessage.CreatedSilence({ silence }) }
				},
				onFailure: (failure) => ({
					model: openCount === model.openCount ? { ...model, isSaving: false } : model,
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: "Couldn't silence alerts",
						description: failure,
					}),
				}),
			}),
	})
