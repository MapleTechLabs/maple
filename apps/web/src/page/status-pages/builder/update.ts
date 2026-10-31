import type {
	StatusPagePreviewParams,
	V2StatusPageCreateParams,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import { STATUS_PAGE_PRESET_DEFAULTS } from "@maple/domain/status-page"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { UPTIME_LIST_LIMIT } from "../../alerts/shared/uptime-commands"
import { statusPageHref } from "../shared/commands"
import {
	draftComponents,
	emptyPicker,
	hasRowIssues,
	monitorCreated,
	monitorFailed,
	seedPicker,
	updatePicker,
} from "../shared/picker"
import { historyFrom } from "../shared/preview"
import { slugFromName, slugIssue } from "../shared/slug"
import {
	CreateBuilderMonitor,
	CreateBuilderPage,
	FetchBuilderMonitors,
	FetchBuilderPreview,
	FetchBuilderSession,
	FocusBuilderField,
	ReadBuilderClock,
	WaitBuilderPreview,
} from "./command"
import { Message } from "./message"
import type { Model, SubmitMode } from "./model"

export type Return = PageReturn<Model, Message>

type BuilderRoute = Extract<AppRoute, { readonly _tag: "StatusPageNew" }>

export const PICKER_ID = "status-page-builder"
export const NAME_ID = "status-page-builder-name"
export const SLUG_ID = "status-page-builder-slug"

const SLUG_TAKEN = "status_page_slug_taken"

const monitorsKey = (context: PageContext) =>
	requestKey(context.orgId, "uptimeMonitors.list", { query: { limit: UPTIME_LIST_LIMIT } })

const readMonitors = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.monitors, monitorsKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (monitors) => ({
			model: { ...model, monitors },
			commands: [FetchBuilderMonitors({ key: monitors.key })],
		}),
	})

export const monitorsOf = (model: Model) => AsyncData.getOrElse(model.monitors.data, () => [])

// ISSUES

export const nameIssue = (model: Model): string | null =>
	model.isNameTouched && model.name.trim() === "" ? "Add a name." : null

/** The address's problem: the server's "taken", or what the API would refuse. */
export const slugError = (model: Model): string | null =>
	model.takenSlug !== null && model.takenSlug === model.slug
		? "That address is taken. Pick another."
		: model.slug === "" && !model.isNameTouched
			? null
			: slugIssue(model.slug)

/** Every check a create must pass, so neither button sends a page the API would refuse. */
export const canSubmit = (model: Model): boolean =>
	model.isAdmin &&
	model.submitting === null &&
	!model.picker.isCreatingMonitor &&
	model.name.trim() !== "" &&
	slugIssue(model.slug) === null &&
	model.takenSlug !== model.slug &&
	!hasRowIssues(model.picker)

// DRAFT

/** The preset carries its own font and corners; the builder offers no other choice of either. */
const themeOf = (model: Model) => ({
	preset: model.preset,
	appearance: model.appearance,
	...STATUS_PAGE_PRESET_DEFAULTS[model.preset],
})

/** What the preview reads; `draftComponents` leaves out rows not named yet, which the API refuses. */
export const previewDraft = (model: Model): StatusPagePreviewParams => ({
	name: model.name.trim(),
	slug: model.slug,
	theme: themeOf(model),
	components: draftComponents(model.picker),
})

export const createPayload = (model: Model, mode: SubmitMode): V2StatusPageCreateParams => ({
	name: model.name.trim(),
	slug: model.slug,
	theme: themeOf(model),
	components: draftComponents(model.picker),
	publish: mode === "publish",
})

/** An edit: the preview is asked for again once the edits pause. */
const edited = (model: Model): Return => {
	const generation = model.previewGeneration + 1
	return {
		model: { ...model, previewGeneration: generation },
		commands: [WaitBuilderPreview({ generation })],
	}
}

export const init = (_route: BuilderRoute, context: PageContext): Return => {
	const model: Model = {
		nowMs: null,
		isAdmin: false,
		isSessionLoaded: false,
		monitors: Keyed.idle(),
		isSeeded: false,
		name: "",
		slug: "",
		isSlugEdited: false,
		isNameTouched: false,
		picker: emptyPicker,
		preset: "default",
		appearance: "auto",
		previewScheme: "light",
		previewGeneration: 0,
		previewShown: 0,
		previewHistory: [],
		isPreviewLoading: false,
		previewFailure: null,
		submitting: null,
		createFailure: null,
		takenSlug: null,
	}
	const read = readMonitors(model, context, "Load")
	return {
		model: read.model,
		commands: [
			ReadBuilderClock(),
			FetchBuilderSession({ orgId: context.orgId }),
			...(read.commands ?? []),
		],
	}
}

/** The first monitors read fills the checklist; later reads (a retry) leave the user's picks. */
const acceptMonitors = (
	model: Model,
	key: string,
	result: Result.Result<ReadonlyArray<V2UptimeMonitor>, LoadFailure>,
): Return => {
	const monitors = Keyed.accept(model.monitors, key, result)
	const next = { ...model, monitors }
	if (model.isSeeded || !AsyncData.hasData(monitors.data)) return { model: next }
	return edited({
		...next,
		isSeeded: true,
		picker: seedPicker(
			AsyncData.getOrElse(monitors.data, () => []),
			true,
		),
	})
}

const pickerStep = (model: Model, message: Parameters<typeof updatePicker>[1]): Return => {
	const step = updatePicker(model.picker, message)
	const next = edited({ ...model, picker: step.picker })
	return {
		model: next.model,
		commands: [
			...(next.commands ?? []),
			...Option.match(step.createMonitor, {
				onNone: () => [],
				onSome: (url) => [CreateBuilderMonitor({ url })],
			}),
		],
	}
}

const submit = (model: Model, mode: SubmitMode): Return =>
	!canSubmit(model)
		? { model: { ...model, isNameTouched: true } }
		: {
				model: { ...model, submitting: mode, createFailure: null },
				commands: [CreateBuilderPage({ mode, payload: createPayload(model, mode) })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin, isSessionLoaded: true } } : { model },
		CompletedFetchMonitors: ({ key, result }) => acceptMonitors(model, key, result),
		ClickedRetry: () => readMonitors(model, context, "Supersede"),
		ChangedName: ({ value }) =>
			edited({ ...model, name: value, slug: model.isSlugEdited ? model.slug : slugFromName(value) }),
		BlurredName: () => ({ model: { ...model, isNameTouched: true } }),
		ChangedSlug: ({ value }) => {
			const slug = value.trim().toLowerCase()
			// Clearing the address hands it back to the name.
			return edited({
				...model,
				slug: slug === "" ? slugFromName(model.name) : slug,
				isSlugEdited: slug !== "",
			})
		},
		GotPickerMessage: ({ message: child }) => pickerStep(model, child),
		CompletedCreateMonitor: ({ result }) =>
			Result.match(result, {
				onSuccess: (monitor): Return =>
					edited({
						...model,
						monitors: {
							...model.monitors,
							data: AsyncData.map(model.monitors.data, (monitors) => [...monitors, monitor]),
						},
						picker: monitorCreated(model.picker, monitor),
					}),
				onFailure: (failure): Return => ({
					model: { ...model, picker: monitorFailed(model.picker, failure.message) },
				}),
			}),
		CompletedFocus: () => ({ model }),
		PickedPreset: ({ preset }) => edited({ ...model, preset }),
		PickedAppearance: ({ appearance }) => edited({ ...model, appearance }),
		PickedPreviewScheme: ({ scheme }) => ({ model: { ...model, previewScheme: scheme } }),
		ElapsedPreviewDebounce: ({ generation }) =>
			generation !== model.previewGeneration
				? { model }
				: {
						model: { ...model, isPreviewLoading: true },
						commands: [FetchBuilderPreview({ generation, draft: previewDraft(model) })],
					},
		// An answer older than the one shown is dropped; the newest keeps loading until it lands.
		CompletedFetchPreview: ({ generation, draft, result }) =>
			generation < model.previewShown
				? { model }
				: Result.match(result, {
						onSuccess: (snapshot): Return => ({
							model: {
								...model,
								previewShown: generation,
								previewHistory: historyFrom(draft, snapshot),
								isPreviewLoading: generation !== model.previewGeneration,
								previewFailure: null,
							},
						}),
						onFailure: (previewFailure): Return => ({
							model: {
								...model,
								previewShown: generation,
								isPreviewLoading: generation !== model.previewGeneration,
								previewFailure,
							},
						}),
					}),
		ClickedSubmit: ({ mode }) => submit(model, mode),
		CompletedCreate: ({ mode, result }) =>
			Result.match(result, {
				onSuccess: (page): Return => ({
					model: { ...model, submitting: null },
					outMessage: PageOutMessage.RequestedNavigation({
						url: statusPageHref(page.id, mode === "publish" ? "live" : undefined),
						isReplace: true,
						...(mode === "draft"
							? {
									toast: {
										type: "success",
										title: "Saved as a draft",
										description: page.name,
									},
								}
							: undefined),
					}),
				}),
				onFailure: (failure): Return =>
					failure.code === SLUG_TAKEN
						? {
								model: { ...model, submitting: null, takenSlug: model.slug },
								commands: [FocusBuilderField({ id: SLUG_ID })],
							}
						: { model: { ...model, submitting: null, createFailure: failure } },
			}),
	})
