import { type DigestSubscriptionResponse, UpsertDigestSubscriptionRequest } from "@maple/domain/http"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect, Option, Predicate, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { loadServicesFacets } from "../../../../data/services-facets-probe"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import * as Combobox from "../../../../ui/combobox"
import { PageOutMessage, type PageReturn } from "../../../contract"
import * as Draft from "../../kit/draft"
import { DigestDraft, Message, type Model, type ScheduleField } from "./model"

type Return = PageReturn<Model, Message>

// Digest preferences: days, hours, defaults and the set-like draft comparison.

/** Monday first, as people read a week; values are `Date#getDay` numbers (0 = Sunday). */
export const DIGEST_DAYS = [
	{ value: 1, label: "Monday" },
	{ value: 2, label: "Tuesday" },
	{ value: 3, label: "Wednesday" },
	{ value: 4, label: "Thursday" },
	{ value: 5, label: "Friday" },
	{ value: 6, label: "Saturday" },
	{ value: 0, label: "Sunday" },
] as const

export const DIGEST_HOURS = Array.from({ length: 24 }, (_, hour) => ({
	value: hour,
	label: `${String(hour).padStart(2, "0")}:00`,
}))

/** The draft for someone with no subscription: the server's Monday 09:00, in the browser's zone. */
const newDigestDraft = (browserZone: string | null): DigestDraft => ({
	dayOfWeek: 1,
	sendHour: 9,
	timezone: browserZone !== null && browserZone !== "" ? browserZone : "UTC",
	namespaces: [],
	environments: [],
})

const sorted = (values: ReadonlyArray<string>) => [...values].sort()

/** Scopes are sets: the same namespaces in another order is not an edit. */
export const sameDigestDraft = (a: DigestDraft, b: DigestDraft): boolean =>
	a.dayOfWeek === b.dayOfWeek &&
	a.sendHour === b.sendHour &&
	a.timezone === b.timezone &&
	sorted(a.namespaces).join("\u0000") === sorted(b.namespaces).join("\u0000") &&
	sorted(a.environments).join("\u0000") === sorted(b.environments).join("\u0000") &&
	a.namespaces.length === b.namespaces.length &&
	a.environments.length === b.environments.length

/** Every zone the browser knows plus UTC, the saved zone and the browser's, UTC first. */
export const digestTimeZoneOptions = (
	supported: ReadonlyArray<string>,
	saved: string,
	browserZone: string | null,
): ReadonlyArray<string> => {
	const zones = new Set([...supported, "UTC", saved])
	if (browserZone !== null && browserZone !== "") zones.add(browserZone)
	return [...zones].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)))
}

// COMMANDS

const ReadEntry = Command.define("ReadEmailPreferencesEntry", {
	messages: [Message.CompletedReadEntry],
	execute: Effect.sync(() =>
		Message.CompletedReadEntry({
			email: window.Clerk?.user?.primaryEmailAddress?.emailAddress ?? null,
			orgName: window.Clerk?.organization?.name ?? null,
			supportedZones: Intl.supportedValuesOf("timeZone"),
			browserZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		}),
	),
})

const DIGEST_NOT_FOUND = "@maple/http/errors/DigestNotFoundError"

/** A 404 is "no subscription yet", not a failure: any other error leaves the preferences unknown. */
const FetchSubscription = Command.define("FetchDigestSubscription", {
	messages: [Message.CompletedFetchSubscription],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.digest.getSubscription()).pipe(
		Effect.map((subscription): DigestSubscriptionResponse | null => subscription),
		Effect.catchIf(
			(error) => Predicate.isTagged(error, DIGEST_NOT_FOUND),
			() => Effect.succeed(null),
		),
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchSubscription({ result })),
	),
})

/** The snapped 24 h facets probe the overview and the namespace switcher share. */
const FetchFacets = Command.define("FetchDigestScopeFacets", {
	messages: [Message.CompletedFetchFacets],
	execute: Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const range = snapRangeForCache({
			startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(now),
		})
		const response = yield* loadServicesFacets(range)
		// The facets carry an empty-string entry for "not reported", which a digest cannot pin to.
		return {
			namespaces: response.data.namespaces.map((item) => item.name).filter((name) => name !== ""),
			environments: response.data.environments.map((item) => item.name).filter((name) => name !== ""),
		}
	}).pipe(
		Effect.orElseSucceed(() => ({ namespaces: [], environments: [] })),
		Effect.map((facets) => Message.CompletedFetchFacets({ facets })),
	),
})

const UpsertFields = Schema.Struct({
	dayOfWeek: Schema.optional(Schema.Number),
	sendHour: Schema.optional(Schema.Number),
	timezone: Schema.optional(Schema.String),
	namespaces: Schema.optional(Schema.Array(Schema.String)),
	environments: Schema.optional(Schema.Array(Schema.String)),
	webAnalyticsEnabled: Schema.optional(Schema.Boolean),
})
type UpsertFields = typeof UpsertFields.Type

/** `enabled` always rides along: the upsert reads a missing value as on. */
const upsert = (email: string, enabled: boolean, fields: UpsertFields) =>
	Effect.flatMap(MapleInternalApiClient, (client) =>
		client.digest.upsertSubscription({
			payload: new UpsertDigestSubscriptionRequest({
				email,
				enabled,
				...(fields.dayOfWeek !== undefined && { dayOfWeek: fields.dayOfWeek }),
				...(fields.sendHour !== undefined && { sendHour: fields.sendHour }),
				...(fields.timezone !== undefined && { timezone: fields.timezone }),
				...(fields.namespaces !== undefined && { namespaces: fields.namespaces }),
				...(fields.environments !== undefined && { environments: fields.environments }),
				...(fields.webAnalyticsEnabled !== undefined && {
					webAnalyticsEnabled: fields.webAnalyticsEnabled,
				}),
			}),
		}),
	).pipe(Effect.asVoid, Effect.mapError(toLoadFailure), Effect.result)

const ToggleDigest = Command.define("ToggleDigest", {
	args: {
		digest: Schema.Literals(["ops", "web"]),
		isOn: Schema.Boolean,
		email: Schema.String,
		enabled: Schema.Boolean,
		fields: UpsertFields,
	},
	messages: [Message.CompletedToggle],
	execute: ({ digest, isOn, email, enabled, fields }) =>
		Effect.map(upsert(email, enabled, fields), (result) =>
			Message.CompletedToggle({ digest, isOn, result }),
		),
})

const SaveDigest = Command.define("SaveDigestPreferences", {
	args: { email: Schema.String, enabled: Schema.Boolean, submitted: DigestDraft },
	messages: [Message.CompletedSave],
	execute: ({ email, enabled, submitted }) =>
		Effect.map(
			upsert(email, enabled, {
				dayOfWeek: submitted.dayOfWeek,
				sendHour: submitted.sendHour,
				timezone: submitted.timezone,
				namespaces: submitted.namespaces,
				environments: submitted.environments,
			}),
			(result) => Message.CompletedSave({ submitted, result }),
		),
})

const PreviewDigest = Command.define("PreviewDigest", {
	args: { digest: Schema.Literals(["ops", "web"]) },
	messages: [Message.CompletedPreview],
	execute: ({ digest }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			digest === "ops" ? client.digest.preview() : client.digest.previewWebAnalytics(),
		).pipe(
			Effect.map((response) => response.html),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedPreview({ result })),
		),
})

/**
 * The email HTML carries org data, so it never runs on the app's origin: a sandboxed iframe with
 * no scripts and an opaque origin, popups allowed so its links still open.
 */
const OpenPreview = Command.define("OpenDigestPreview", {
	args: { html: Schema.String },
	messages: [Message.CompletedPreview],
	execute: ({ html }) =>
		Effect.sync(() => {
			const win = window.open("", "_blank")
			if (win !== null) {
				win.opener = null
				win.document.title = "Email preview"
				win.document.body.style.margin = "0"
				const frame = win.document.createElement("iframe")
				frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox")
				frame.srcdoc = html
				frame.style.cssText = "border:0;width:100vw;height:100vh;display:block"
				win.document.body.append(frame)
			}
			return Message.CompletedPreview({ result: Result.succeed("") })
		}),
})

// DERIVED

const savedOf = (model: Model): DigestSubscriptionResponse | null =>
	Option.getOrNull(Option.flatMap(AsyncData.getData(model.subscription), Option.fromNullishOr))

export const isOpsEnabled = (model: Model): boolean => savedOf(model)?.enabled ?? true
export const isWebEnabled = (model: Model): boolean => savedOf(model)?.webAnalyticsEnabled ?? true

/** The saved schedule and scope, or the defaults in the browser's zone for someone who never saved. */
export const baselineOf = (model: Model): DigestDraft => {
	const saved = savedOf(model)
	return saved === null
		? newDigestDraft(model.browserZone)
		: {
				dayOfWeek: saved.dayOfWeek,
				sendHour: saved.sendHour,
				timezone: saved.timezone,
				namespaces: saved.namespaces,
				environments: saved.environments,
			}
}

export const draftOf = (model: Model): DigestDraft => Draft.draftOf(model.draft, baselineOf(model))
export const isDraftDirty = (model: Model): boolean =>
	Draft.isDirty(model.draft, baselineOf(model), sameDigestDraft)
export const isBusy = (model: Model): boolean => model.isTogglingOps || model.isTogglingWeb || model.isSaving

/** The first write records the prefilled zone, so a toggle alone does not leave the row on UTC. */
const firstWrite = (model: Model): UpsertFields =>
	savedOf(model) === null ? { timezone: baselineOf(model).timezone } : {}

// UPDATE

export const init = (): Return => ({
	model: {
		isLoaded: false,
		email: null,
		orgName: null,
		supportedZones: [],
		browserZone: null,
		subscription: AsyncData.Loading(),
		facets: { namespaces: [], environments: [] },
		isFacetsRequested: false,
		draft: Draft.emptyDraft(),
		isTogglingOps: false,
		isTogglingWeb: false,
		isSaving: false,
		previewing: null,
		namespacesBox: Combobox.init("digest-namespaces", "multiple"),
		environmentsBox: Combobox.init("digest-environments", "multiple"),
	},
	commands: [ReadEntry(), FetchSubscription()],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const editDraft = (model: Model, patch: Partial<DigestDraft>): Model => ({
	...model,
	draft: Draft.setDraft(model.draft, { ...draftOf(model), ...patch }),
})

const scheduleValue = (field: ScheduleField, value: string): Partial<DigestDraft> =>
	field === "timezone"
		? { timezone: value }
		: field === "dayOfWeek"
			? { dayOfWeek: Number(value) }
			: { sendHour: Number(value) }

/** The chips mirror the draft: the combobox's own selection is replaced by the draft's. */
const updateScope = (
	model: Model,
	key: "namespaces" | "environments",
	message: Combobox.Message,
	wrap: (message: Combobox.Message) => Message,
): Return => {
	const boxKey = key === "namespaces" ? "namespacesBox" : "environmentsBox"
	const step = Combobox.update({ ...model[boxKey], selected: draftOf(model)[key] }, message)
	const next = { ...model, [boxKey]: step.model }
	const commands = Command.mapMessages(step.commands ?? [], wrap)
	return step.outMessage?._tag === "ChangedSelection"
		? { model: editDraft(next, { [key]: step.outMessage.selected }), commands }
		: { model: next, commands }
}

const toggle = (model: Model, digest: "ops" | "web"): Return => {
	if (model.email === null || isBusy(model)) return { model }
	const enabled = isOpsEnabled(model)
	const isOn = digest === "ops" ? !enabled : !isWebEnabled(model)
	const fields = digest === "ops" ? firstWrite(model) : { ...firstWrite(model), webAnalyticsEnabled: isOn }
	return {
		model: { ...model, ...(digest === "ops" ? { isTogglingOps: true } : { isTogglingWeb: true }) },
		commands: [
			ToggleDigest({
				digest,
				isOn,
				email: model.email,
				enabled: digest === "ops" ? isOn : enabled,
				fields,
			}),
		],
	}
}

const refetch = (model: Model): Return => ({
	model: {
		...model,
		subscription: Option.getOrElse(AsyncData.revalidate(model.subscription), () => model.subscription),
	},
	commands: [FetchSubscription()],
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedReadEntry: (entry) => ({ model: { ...model, ...entry, isLoaded: true } }),
		CompletedFetchSubscription: ({ result }) => {
			const next = { ...model, subscription: AsyncData.settle(model.subscription, result) }
			const showsScope = Result.isSuccess(result) && isOpsEnabled(next) && !next.isFacetsRequested
			return {
				model: {
					...next,
					draft: Draft.settle(next.draft, baselineOf(next), sameDigestDraft),
					isFacetsRequested: next.isFacetsRequested || showsScope,
				},
				commands: showsScope ? [FetchFacets()] : [],
			}
		},
		CompletedFetchFacets: ({ facets }) => ({ model: { ...model, facets } }),
		ClickedRetry: () => ({
			model: { ...model, subscription: AsyncData.Loading() },
			commands: [FetchSubscription()],
		}),
		ToggledOps: () => toggle(model, "ops"),
		ToggledWeb: () => toggle(model, "web"),
		CompletedToggle: ({ digest, isOn, result }) => {
			const settled = { ...model, isTogglingOps: false, isTogglingWeb: false }
			const name = digest === "ops" ? "Weekly ops digest" : "Web analytics digest"
			return Result.match(result, {
				onSuccess: () => ({
					...refetch(settled),
					outMessage: toast("success", `${name} turned ${isOn ? "on" : "off"}`),
				}),
				onFailure: (error) => ({
					model: settled,
					outMessage: toast(
						"error",
						`Failed to update the ${digest === "ops" ? "weekly ops" : "web analytics"} digest`,
						error.message,
					),
				}),
			})
		},
		ChangedSchedule: ({ field, value }) => ({ model: editDraft(model, scheduleValue(field, value)) }),
		GotNamespacesMessage: ({ message: child }) =>
			updateScope(model, "namespaces", child, (inner) =>
				Message.GotNamespacesMessage({ message: inner }),
			),
		GotEnvironmentsMessage: ({ message: child }) =>
			updateScope(model, "environments", child, (inner) =>
				Message.GotEnvironmentsMessage({ message: inner }),
			),
		ClickedDiscard: () => ({ model: { ...model, draft: Draft.discard() } }),
		ClickedSave: () => {
			// Save resends the pre-toggle `enabled`, which would undo a toggle in flight.
			if (model.email === null || isBusy(model)) return { model }
			const submitted = draftOf(model)
			return {
				model: { ...model, isSaving: true, draft: Draft.submit(model.draft, baselineOf(model)) },
				commands: [SaveDigest({ email: model.email, enabled: isOpsEnabled(model), submitted })],
			}
		},
		CompletedSave: ({ submitted, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					...refetch({
						...model,
						isSaving: false,
						draft: Draft.commit(
							model.draft,
							{ submitted, sent: null },
							baselineOf(model),
							sameDigestDraft,
						),
					}),
					outMessage: toast("success", "Email preferences saved"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSaving: false, draft: Draft.abort(model.draft) },
					outMessage: toast("error", "Failed to save email preferences", error.message),
				}),
			}),
		ClickedPreview: ({ digest }) =>
			model.previewing !== null
				? { model }
				: { model: { ...model, previewing: digest }, commands: [PreviewDigest({ digest })] },
		CompletedPreview: ({ result }) =>
			Result.match(result, {
				onSuccess: (html) =>
					html === "" || model.previewing === null
						? { model: { ...model, previewing: null } }
						: { model: { ...model, previewing: null }, commands: [OpenPreview({ html })] },
				onFailure: (error) => ({
					model: { ...model, previewing: null },
					outMessage: toast("error", "Failed to generate the preview", error.message),
				}),
			}),
	})
