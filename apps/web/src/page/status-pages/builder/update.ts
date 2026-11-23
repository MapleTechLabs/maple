import type {
	StatusPageDraftComponent,
	StatusPagePreviewParams,
	V2StatusPageCreateParams,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	customDomainIssue,
	normalizeCustomDomain,
	slugFromName,
	STATUS_PAGE_PRESET_DEFAULTS,
} from "@maple/domain/status-page"
import { Option, Result, Array as Arr, String as Str } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { UPTIME_LIST_LIMIT } from "../../kit/uptime/commands"
import { statusPageHref } from "../shared/commands"
import { groupedOrder, groupIndexOf, groupOrder, moved, movedGroup } from "../shared/component-order"
import { componentPayload, type ComponentForm, emptyComponentForm, orNull } from "../shared/form"
import type * as Combobox from "@maple/views/ui/combobox"
import { initGroupPicker, updateGroupPicker } from "../shared/group-picker"
import {
	draftComponents,
	emptyPicker,
	hasRowIssues,
	monitorCreated,
	monitorFailed,
	monitorKey,
	PRECHECK_MAX_MONITORS,
	type PickerMessage,
	seedPicker,
	updatePicker,
} from "../shared/picker"
import { historyFrom } from "../shared/preview"
import { SLUG_TAKEN, SLUG_TAKEN_MESSAGE, slugIssue } from "../shared/slug"
import {
	CreateBuilderMonitor,
	CreateBuilderPage,
	FetchBuilderMonitors,
	FetchBuilderPreview,
	FetchBuilderSession,
	FocusBuilderField,
	SetBuilderCustomDomain,
	ReadBuilderClock,
	ComputeBuilderOrgKey,
	TrackMonitorCreated,
	TrackPageCreated,
	WaitBuilderPreview,
} from "./command"
import { Message } from "./message"
import { canManage, type DraftRow, type Model, type SubmitMode } from "./model"
import { acceptGrants } from "../../kit/session-grants"

export type Return = PageReturn<Model, Message>

type BuilderRoute = Extract<AppRoute, { readonly _tag: "StatusPageNew" }>

export const PICKER_ID = "status-page-builder"
export const ADD_PICKER_ID = "status-page-builder-add"
export const FIELDS_ID = "status-page-builder-component"
export const NAME_ID = "status-page-builder-name"
export const SLUG_ID = "status-page-builder-slug"
export const DOMAIN_ID = "status-page-builder-domain-input"

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

const hasCustomDomain = (model: Model): boolean => Str.trim(model.customDomain) !== ""

/** Why the typed custom domain cannot be set; nothing while the field is empty (it is optional). */
export const customDomainError = (model: Model): string | null =>
	hasCustomDomain(model) ? customDomainIssue(normalizeCustomDomain(model.customDomain)) : null

export const nameIssue = (model: Model): string | null =>
	model.isNameTouched && Str.trim(model.name) === "" ? "Add a name." : null

/** The address's problem: the server's "taken", or what the API would refuse. */
export const slugError = (model: Model): string | null =>
	model.takenSlug !== null && model.takenSlug === model.slug
		? SLUG_TAKEN_MESSAGE
		: model.slug === "" && !model.isNameTouched
			? null
			: slugIssue(model.slug)

const safeKey = (key: string) => Str.replace(":", "-")(key)

/** A row's head in the list: the button that opens and closes it. */
export const rowIdOf = (key: string): string => `${PICKER_ID}-row-${safeKey(key)}`

/** A row's drag grip in the list. */
export const gripIdOf = (key: string): string => `${PICKER_ID}-grip-${safeKey(key)}`

/** A group's drag grip in the list. */
export const groupGripIdOf = (group: string | null): string =>
	`${PICKER_ID}-group-grip-${group === null ? "none" : encodeURIComponent(group)}`

/** The rows as the order helpers take them: the key as the id, a blank group as none. */
const placed = (rows: ReadonlyArray<DraftRow>) =>
	Arr.map(rows, (row) => ({ id: row.key, group: orNull(row.form.group), row }))

/** The rows as the page lists them: each group where its first member is, members in order. */
export const orderedRows = (model: Model): ReadonlyArray<DraftRow> =>
	Arr.map(groupedOrder(placed(model.rows)), (item) => item.row)

const isNamed = (row: DraftRow) => Str.trim(row.form.name) !== ""

/** Every check a create must pass, so neither button sends a page the API would refuse. */
export const canSubmit = (model: Model): boolean =>
	canManage(model) &&
	model.submitting === null &&
	!model.addPicker.isCreatingMonitor &&
	Str.trim(model.name) !== "" &&
	slugIssue(model.slug) === null &&
	model.takenSlug !== model.slug &&
	Arr.every(model.rows, isNamed) &&
	customDomainError(model) === null

/** The preset carries its own font and corners; the builder offers no other choice of either. */
const themeOf = (model: Model) => ({
	preset: model.preset,
	appearance: model.appearance,
	...STATUS_PAGE_PRESET_DEFAULTS[model.preset],
})

/** The page's components in page order; rows not named yet are left out, which the API refuses. */
const componentsOf = (model: Model): ReadonlyArray<StatusPageDraftComponent> =>
	Arr.map(Arr.filter(orderedRows(model), isNamed), (row) => componentPayload(row.form))

export const previewDraft = (model: Model): StatusPagePreviewParams => ({
	name: Str.trim(model.name),
	slug: model.slug,
	theme: themeOf(model),
	components: componentsOf(model),
})

export const createPayload = (model: Model, mode: SubmitMode): V2StatusPageCreateParams => ({
	name: Str.trim(model.name),
	slug: model.slug,
	theme: themeOf(model),
	components: componentsOf(model),
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

export const init = (route: BuilderRoute, context: PageContext): Return => {
	const model: Model = {
		setup: route.search.setup ?? null,
		promptCopy: CopyButton.init(),
		mcpCommandCopy: CopyButton.init(),
		nowMs: null,
		grants: [],
		isSessionLoaded: false,
		monitors: Keyed.idle(),
		isSeeded: false,
		name: "",
		slug: "",
		orgKey: "",
		customDomain: "",
		isSlugEdited: false,
		isNameTouched: false,
		rows: [],
		nextKey: 1,
		openKey: null,
		groupPicker: initGroupPicker("status-page-builder-group"),
		addSheet: Dialog.init("status-page-builder-add", "sheet"),
		addPicker: emptyPicker,
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
			ComputeBuilderOrgKey({ orgId: context.orgId }),
			FetchBuilderSession({ orgId: context.orgId }),
			...(read.commands ?? []),
		],
	}
}

/** The method in the address changed (picked, or Back to the choice); the builder keeps its edits. */
export const routeChanged = (model: Model, route: BuilderRoute): Return => ({
	model: { ...model, setup: route.search.setup ?? null },
})

const monitorForm = (monitor: V2UptimeMonitor): ComponentForm => ({
	...emptyComponentForm,
	name: monitor.name,
	monitorId: monitor.id,
})

/** A small org's page starts with every monitor on it but heartbeats; past that, the user adds them. */
const seedRows = (monitors: ReadonlyArray<V2UptimeMonitor>): ReadonlyArray<DraftRow> =>
	monitors.length > PRECHECK_MAX_MONITORS
		? []
		: Arr.flatMap(monitors, (monitor) =>
				monitor.kind === "heartbeat"
					? []
					: [{ key: monitorKey(monitor.id), form: monitorForm(monitor) }],
			)

/** The first monitors read fills the list; later reads (a retry) leave the user's rows.*/
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
		rows: seedRows(AsyncData.getOrElse(monitors.data, () => [])),
	})
}

/** The open row's fields, changed by `change`; an edit, so the preview follows. */
const editOpen = (model: Model, change: (form: ComponentForm) => ComponentForm): Return =>
	model.openKey === null
		? { model }
		: edited({
				...model,
				rows: Arr.map(model.rows, (row) =>
					row.key === model.openKey ? { ...row, form: change(row.form) } : row,
				),
			})

const groupPickerStep = (model: Model, message: Combobox.Message): Return => {
	const step = updateGroupPicker(model.groupPicker, message)
	const withState = { ...model, groupPicker: step.picker }
	const next = Option.match(step.picked, {
		onNone: (): Return => ({ model: withState }),
		onSome: (group) => editOpen(withState, (form) => ({ ...form, group })),
	})
	return {
		...next,
		commands: [
			...(next.commands ?? []),
			...FoldkitCommand.mapMessages(step.commands, (child) =>
				Message.GotGroupPickerMessage({ message: child }),
			),
		],
	}
}

/** The row at `index` among its group's rows; nothing when it is already there. */
const moveRow = (model: Model, key: string, index: number): Model | null => {
	const next = moved(placed(model.rows), key, index)
	return next === null ? null : { ...model, rows: Arr.map(next, (item) => item.row) }
}

/** An arrow key on the grip: one slot up (-1) or down (1), focus kept on the moved row's grip. */
const nudgeRow = (model: Model, key: string, offset: number): Return => {
	const from = groupIndexOf(placed(model.rows), key)
	const next = from === null ? null : moveRow(model, key, from + offset)
	if (next === null) return { model }
	const step = edited(next)
	return { ...step, commands: [...(step.commands ?? []), FocusBuilderField({ id: gripIdOf(key) })] }
}

/** The group's rows, together, at the `index`th place among the groups. */
const moveGroupTo = (model: Model, group: string | null, index: number): Model | null => {
	const next = movedGroup(placed(model.rows), group, index)
	return next === null ? null : { ...model, rows: Arr.map(next, (item) => item.row) }
}

const nudgeGroup = (model: Model, group: string | null, offset: number): Return => {
	const from = groupOrder(placed(model.rows)).indexOf(group)
	const next = from === -1 ? null : moveGroupTo(model, group, from + offset)
	if (next === null) return { model }
	const step = edited(next)
	return {
		...step,
		commands: [...(step.commands ?? []), FocusBuilderField({ id: groupGripIdOf(group) })],
	}
}

const removeRow = (model: Model, key: string): Return =>
	edited({
		...model,
		rows: Arr.filter(model.rows, (row) => row.key !== key),
		openKey: model.openKey === key ? null : model.openKey,
	})

const sheetCommands = (step: ReturnType<typeof Dialog.update>) =>
	FoldkitCommand.mapMessages(step.commands ?? [], (message) => Message.GotAddSheetMessage({ message }))

/** Add components: the monitors not on the page yet, none picked; a URL or a component by hand join them. */
const openAdd = (model: Model): Return => {
	const used = new Set(
		Arr.flatMap(model.rows, (row) => (row.form.monitorId === "" ? [] : [row.form.monitorId])),
	)
	const step = Dialog.open(model.addSheet)
	return {
		model: {
			...model,
			addSheet: step.model,
			addPicker: seedPicker(
				Arr.filter(monitorsOf(model), (monitor) => !used.has(monitor.id)),
				false,
			),
		},
		commands: sheetCommands(step),
	}
}

const formOf = (component: StatusPageDraftComponent): ComponentForm => ({
	...emptyComponentForm,
	name: component.name,
	group: component.group ?? "",
	monitorId: component.monitor_id ?? "",
	manualStatus: component.manual_status ?? "",
	showUptime: component.show_uptime ?? true,
})

/** What is ticked joins the page at the end, and the sheet closes. */
const submitAdd = (model: Model): Return => {
	const components = draftComponents(model.addPicker)
	if (components.length === 0 || hasRowIssues(model.addPicker) || model.addPicker.isCreatingMonitor)
		return { model }
	const added = Arr.map(components, (component, index): DraftRow => ({
		key:
			component.monitor_id === null || component.monitor_id === undefined
				? `c:${model.nextKey + index}`
				: monitorKey(component.monitor_id),
		form: formOf(component),
	}))
	const step = Dialog.close(model.addSheet)
	const next = edited({
		...model,
		rows: [...model.rows, ...added],
		nextKey: model.nextKey + added.length,
		addSheet: step.model,
	})
	return { ...next, commands: [...(next.commands ?? []), ...sheetCommands(step)] }
}

const addPickerStep = (model: Model, message: PickerMessage): Return => {
	const step = updatePicker(model.addPicker, message)
	return {
		model: { ...model, addPicker: step.picker },
		commands: Option.match(step.createMonitor, {
			onNone: () => [],
			onSome: (url) => [CreateBuilderMonitor({ url })],
		}),
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
		ComputedOrgKey: ({ orgKey }) => ({ model: { ...model, orgKey } }),
		CompletedFetchSession: (answer) => ({
			model: acceptGrants(model, context.orgId, answer, { isSessionLoaded: true }),
		}),
		CompletedFetchMonitors: ({ key, result }) => acceptMonitors(model, key, result),
		ClickedRetry: () => readMonitors(model, context, "Supersede"),
		GotPromptCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.promptCopy, inner)
			return {
				model: { ...model, promptCopy: next.model },
				commands: FoldkitCommand.mapMessages(next.commands ?? [], (message) =>
					Message.GotPromptCopyMessage({ message }),
				),
			}
		},
		GotMcpCommandCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.mcpCommandCopy, inner)
			return {
				model: { ...model, mcpCommandCopy: next.model },
				commands: FoldkitCommand.mapMessages(next.commands ?? [], (message) =>
					Message.GotMcpCommandCopyMessage({ message }),
				),
			}
		},
		ChangedName: ({ value }) =>
			edited({ ...model, name: value, slug: model.isSlugEdited ? model.slug : slugFromName(value) }),
		BlurredName: () => ({ model: { ...model, isNameTouched: true } }),
		ChangedSlug: ({ value }) => {
			const slug = Str.toLowerCase(Str.trim(value))
			// Clearing the address hands it back to the name.
			return edited({
				...model,
				slug: slug === "" ? slugFromName(model.name) : slug,
				isSlugEdited: slug !== "",
			})
		},
		ClickedRow: ({ key }) => ({ model: { ...model, openKey: model.openKey === key ? null : key } }),
		ChangedRowField: ({ field, value }) => editOpen(model, (form) => ({ ...form, [field]: value })),
		ToggledRowUptime: () => editOpen(model, (form) => ({ ...form, showUptime: !form.showUptime })),
		GotGroupPickerMessage: ({ message: child }) => groupPickerStep(model, child),
		ClickedRemoveRow: ({ key }) => removeRow(model, key),
		DroppedRow: ({ key, index }) => {
			const next = moveRow(model, key, index)
			return next === null ? { model } : edited(next)
		},
		PressedMoveRow: ({ key, offset }) => nudgeRow(model, key, offset),
		DroppedGroup: ({ group, index }) => {
			const next = moveGroupTo(model, group, index)
			return next === null ? { model } : edited(next)
		},
		PressedMoveGroup: ({ group, offset }) => nudgeGroup(model, group, offset),
		ClickedAddComponents: () => openAdd(model),
		GotAddSheetMessage: ({ message: child }) => {
			const step = Dialog.update(model.addSheet, child)
			return { model: { ...model, addSheet: step.model }, commands: sheetCommands(step) }
		},
		GotAddPickerMessage: ({ message: child }) => addPickerStep(model, child),
		ClickedSubmitAdd: () => submitAdd(model),
		// A monitored URL goes straight onto the page, with any rows already ticked beside it.
		CompletedCreateMonitor: ({ result }) =>
			Result.match(result, {
				onSuccess: (monitor): Return => {
					const next = submitAdd({
						...model,
						monitors: {
							...model.monitors,
							data: AsyncData.map(model.monitors.data, (monitors) => [...monitors, monitor]),
						},
						addPicker: monitorCreated(model.addPicker, monitor),
					})
					return {
						...next,
						commands: [...(next.commands ?? []), TrackMonitorCreated({ kind: monitor.kind })],
					}
				},
				onFailure: (failure): Return => ({
					model: { ...model, addPicker: monitorFailed(model.addPicker, failure.message) },
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
				// With a custom domain the buttons keep spinning until it is set too.
				onSuccess: (page): Return =>
					hasCustomDomain(model)
						? {
								model,
								commands: [
									TrackPageCreated(),
									SetBuilderCustomDomain({
										page,
										hostname: normalizeCustomDomain(model.customDomain),
									}),
								],
							}
						: {
								model: { ...model, submitting: null },
								commands: [TrackPageCreated()],
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
							},
				onFailure: (failure): Return =>
					failure.code === SLUG_TAKEN
						? {
								model: { ...model, submitting: null, takenSlug: model.slug },
								commands: [FocusBuilderField({ id: SLUG_ID })],
							}
						: { model: { ...model, submitting: null, createFailure: failure } },
			}),
		// Either way the page exists: it opens on its Custom domain, with the DNS records to add.
		CompletedSetCustomDomain: ({ page, result }) => ({
			model: { ...model, submitting: null },
			outMessage: PageOutMessage.RequestedNavigation({
				url: statusPageHref(page.id, "settings", "basic"),
				isReplace: true,
				toast: Result.match(result, {
					onSuccess: (domain) => ({
						type: "success" as const,
						title: `${page.name} created`,
						description: `Add the DNS records shown for ${domain.hostname ?? "your domain"} to finish.`,
					}),
					onFailure: (failure) => ({
						type: "error" as const,
						title: `${page.name} created, but its custom domain wasn't set`,
						description: failure.message,
					}),
				}),
			}),
		}),
		ChangedCustomDomain: ({ value }) => ({ model: { ...model, customDomain: value } }),
		CompletedTrackProduct: () => ({ model }),
	})
