import type { StatusPagePreviewParams } from "@maple/domain/http/v2"
import { STATUS_PAGE_PRESET_DEFAULTS } from "@maple/domain/status-page"
import { PREVIEW_FIELDS } from "@maple/status-page"
import { Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { AppRoute } from "../../../route"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { type PageContext, PageOutMessage } from "../../contract"
import type { StatusPageSearch } from "../../../route/search"
import {
	pageIdFromUrl,
	SETTINGS_SECTIONS,
	type SettingsSection,
	publicPageLink,
	STATUS_PAGE_BASE_URL,
	statusPageHref,
	statusPageViewHref,
} from "../shared/commands"
import { OPEN_PREVIEW_VALUE, OPEN_PUBLIC_VALUE } from "../shared/open-page"
import { emptyComponentForm, emptyIncidentForm } from "../shared/form"
import { initGroupPicker } from "../shared/group-picker"
import { emptyPicker } from "../shared/picker"
import { historyFrom, type PreviewSelection } from "../shared/preview"
import {
	FetchEditorPreview,
	FetchEditorSession,
	OpenPublicPage,
	PREVIEW_FIELD_TARGETS,
	ReadEditorClock,
	RevealEditorField,
	WaitEditorPreview,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	componentsOf,
	incidentsOf,
	pageOf,
	readComponents,
	readConfig,
	readIncidents,
	readMonitors,
	readPage,
	type Return,
} from "./reads"
import {
	addedComponents,
	addMonitorCreated,
	addPickerStep,
	askDeleteComponent,
	changeComponent,
	confirmDeleteComponent,
	confirmDiscardComponent,
	deleteComponentDialog,
	deletedComponent,
	discardComponentDialog,
	discardMonitors,
	groupPickerStep,
	leaveComponent,
	moveComponent,
	moveGroup,
	nudgeGroup,
	nudgeComponent,
	reordered,
	saveMonitors,
	savedComponent,
	submitAdd,
	toggleComponentUptime,
	unsavedComponent,
} from "./update-components"
import {
	askDeleteIncident,
	backToIncidentWrite,
	backToUpdateWrite,
	changeIncident,
	changeIncidentEdit,
	changeIncidentKind,
	changeUpdate,
	composeDialog,
	confirmDeleteIncident,
	createdIncident,
	deletedIncident,
	deleteIncidentDialog,
	editIncidentDialog,
	openComposer,
	openIncidentEdit,
	openUpdate,
	postedUpdate,
	publishedIncident,
	publishIncident,
	reviewIncident,
	reviewUpdate,
	savedIncident,
	selectIncident,
	submitIncident,
	submitIncidentEdit,
	submitUpdate,
	toggleIncidentComponent,
	toggleIncidentEditComponent,
	updateDialog,
} from "./update-incidents"
import {
	askBreakGlass,
	breakGlassDialog,
	changeSetting,
	confirmDeletePage,
	deletedPage,
	deletePageDialog,
	published,
	publish,
	revoked,
	rotated,
	runBreakGlass,
	savedSettings,
	saveSettings,
	togglePoweredBy,
	pickBrandingImage,
	editBrandingImage,
	brandingDialog,
	submitBrandingLink,
	takeBrandingImage,
	readBrandingImage,
	removeBrandingImage,
	changeTheme,
	updateTokenCopy,
} from "./update-settings"
import { changedAccess, changePassword, discardAccess, pickVisibility, saveAccess } from "./update-access"
import {
	appliedJson,
	applyJson,
	cancelJson,
	changeJson,
	editJson,
	rebaseJsonDraft,
	updateJsonCopy,
} from "./update-json"
import {
	changeCustomDomain,
	checkCustomDomain,
	checkedCustomDomain,
	confirmRemoveCustomDomain,
	pageUrlOf,
	readCustomDomain,
	removeCustomDomainDialog,
	removedCustomDomain,
	savedCustomDomain,
	submitCustomDomain,
	updateDnsCopy,
} from "./update-domain"
import { acceptGrants } from "../../kit/session-grants"

type EditorRoute = Extract<AppRoute, { readonly _tag: "StatusPage" }>

/** The editor's tabs: the live page, incidents, maintenance, settings, and the just-published screen. */
export type EditorTab = "page" | "incidents" | "maintenance" | "settings" | "live"

export type EditorLocation = Readonly<{ tab: EditorTab; section: SettingsSection }>

const isSection = (value: string | undefined): value is SettingsSection =>
	Arr.some(SETTINGS_SECTIONS, (section) => section === value)

/**
 * Where the search points; anything unknown is the live page, so an old or mistyped link lands.
 * The old Appearance and JSON tabs are Settings sections now.
 */
export const resolveView = (search: typeof StatusPageSearch.Type): EditorLocation => {
	const section = isSection(search.section) ? search.section : "basic"
	switch (search.view) {
		case "incidents":
		case "maintenance":
		case "settings":
		case "live":
			return { tab: search.view, section }
		case "appearance":
			return { tab: "settings", section: "appearance" }
		case "json":
			return { tab: "settings", section: "advanced" }
		default:
			return { tab: "page", section }
	}
}

/** The Settings sections whose fields change how the page looks, so the page's preview sits beside them. */
// Not Basic settings: nothing there changes how the page looks, so a preview beside it only misleads.
export const PREVIEWED_SECTIONS: ReadonlyArray<SettingsSection> = ["monitors", "appearance"]

/** Whether the location draws the page in a frame whose components and incidents click. */
export const hasClickablePreview = (location: EditorLocation): boolean =>
	location.tab === "page" || (location.tab === "settings" && PREVIEWED_SECTIONS.includes(location.section))

/** Whether the tab shows what is open: a component under Monitors, an incident under its tab. */
const showsPanel = (panel: Model["panel"], location: EditorLocation): boolean => {
	if (panel === null) return false
	switch (panel._tag) {
		case "Component":
		case "Add":
			return location.tab === "settings" && location.section === "monitors"
		case "Incident":
			return location.tab === "incidents" || location.tab === "maintenance"
	}
}

export const PAGE_MENU_ID = "status-page-menu"

export const init = (route: EditorRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		rawPageId: route.pageId,
		pageId: Option.getOrNull(pageIdFromUrl(route.pageId)),
		nowMs: null,
		revealComponentId: null,
		revealFieldId: null,
		page: Keyed.idle(),
		components: Keyed.idle(),
		incidents: Keyed.idle(),
		config: Keyed.idle(),
		monitors: Keyed.idle(),
		grants: [],
		isSessionLoaded: false,
		pageMenu: Menu.init(PAGE_MENU_ID),
		panel: null,
		panelSheet: Dialog.init("status-page-panel", "sheet"),
		sheetPanel: null,
		sheetIncident: null,
		previewScheme: "light",
		previewWidth: "desktop",
		previewState: "live",
		previewGeneration: 0,
		previewShown: 0,
		previewHistory: [],
		componentForm: emptyComponentForm,
		componentSave: null,
		groupPicker: initGroupPicker("status-page-component-group"),
		pendingLeave: null,
		discardComponentDialog: Dialog.init("status-page-discard-component", "alert-dialog"),
		confirmDeleteComponentId: null,
		deleteComponentDialog: Dialog.init("status-page-delete-component", "alert-dialog"),
		isDeletingComponent: false,
		pendingOrder: null,
		isSavingOrder: false,
		orderFailure: null,
		addPicker: emptyPicker,
		isAddingComponents: false,
		addSession: 0,
		composeDialog: Dialog.init("status-page-compose", "dialog"),
		composeStep: "write",
		incidentForm: emptyIncidentForm("incident"),
		isCreatingIncident: false,
		incidentFailure: null,
		updateDialog: Dialog.init("status-page-update", "dialog"),
		updateForm: { _tag: "Closed" },
		publishingIncidentIds: [],
		editIncidentDialog: Dialog.init("status-page-edit-incident", "dialog"),
		incidentEdit: null,
		isSavingIncident: false,
		incidentEditFailure: null,
		confirmDeleteIncidentId: null,
		deleteIncidentDialog: Dialog.init("status-page-delete-incident", "alert-dialog"),
		isDeletingIncident: false,
		publicBaseUrl: STATUS_PAGE_BASE_URL,
		urlCopy: CopyButton.init(),
		settingsEdits: null,
		brandingDrag: null,
		brandingDialog: Dialog.init("status-page-branding-image", "dialog"),
		brandingDialogField: "logoUrl",
		brandingLink: "",
		brandingRead: 0,
		isSavingSettings: false,
		savesAccessNext: false,
		settingsFailure: null,
		takenSlug: null,
		isPublishing: false,
		breakGlassDialog: Dialog.init("status-page-break-glass", "alert-dialog"),
		breakGlassAction: null,
		isChangingBreakGlass: false,
		revealedToken: null,
		tokenCopy: CopyButton.init(),
		deletePageDialog: Dialog.init("status-page-delete", "alert-dialog"),
		isDeletingPage: false,
		accessAction: null,
		visibilityDraft: null,
		passwordDraft: "",
		accessFailure: null,
		customDomain: Keyed.idle(),
		customDomainDraft: null,
		customDomainAction: null,
		customDomainFailure: null,
		removeCustomDomainDialog: Dialog.init("status-page-remove-custom-domain", "alert-dialog"),
		dnsCopy: CopyButton.init(),
		dnsCopyKey: null,
		jsonEdit: null,
		isApplyingJson: false,
		jsonFailure: null,
		jsonCopy: CopyButton.init(),
	}
	const reads = chain(
		model,
		readPage(context, "Load"),
		readComponents(context, "Load"),
		readIncidents(context, "Load"),
		readMonitors(context, "Load"),
		readCustomDomain(context, "Load"),
		whenJson(context, "Load"),
	)
	return {
		model: reads.model,
		commands: [
			ReadEditorClock(),
			FetchEditorSession({ orgId: context.orgId }),
			...(reads.commands ?? []),
		],
	}
}

/** The config read, only while Advanced (the JSON editor) is open: the document must be current when edited. */
const whenJson =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const location = resolveView(model.search)
		return location.tab === "settings" && location.section === "advanced"
			? readConfig(context, mode)(model)
			: { model }
	}

/** The custom domain moves on the server's schedule: opening Settings shows where it is now. */
const whenSettings =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return =>
		resolveView(model.search).tab === "settings" ? readCustomDomain(context, mode)(model) : { model }

/**
 * What is open stays open only where `location` shows it. A navigation cannot wait on a confirm, so
 * a component's unsaved edits stay in the form, neither saved nor dropped, and Monitors opens on them.
 */
const settlePanel = (model: Model, location: EditorLocation): Model =>
	showsPanel(model.panel, location)
		? model
		: Option.match(unsavedComponent(model), {
				onNone: () => ({ ...model, panel: null, componentForm: emptyComponentForm }),
				onSome: (component) => ({
					...model,
					panel:
						location.tab === "settings" && location.section === "monitors"
							? { _tag: "Component", componentId: component.id }
							: null,
				}),
			})

/**
 * A tab switch is a search change. Opening Advanced re-reads the config, since other sections
 * write too.
 */
export const routeChanged = (model: Model, route: EditorRoute, context: PageContext): Return =>
	withSheet(
		chain(
			settlePanel({ ...model, search: route.search, revealFieldId: null }, resolveView(route.search)),
			whenJson(context, "Refresh"),
			whenSettings(context, "Refresh"),
			(next) =>
				model.revealFieldId === null
					? { model: next }
					: { model: next, commands: [RevealEditorField({ id: model.revealFieldId })] },
		),
	)

/** The dialogs ignore dismissal while their write is in flight, as `ConfirmDialog` does. */
const whenIdle = (isBusy: boolean, model: Model, run: () => Return): Return => (isBusy ? { model } : run())

// PREVIEW

const isPreviewField = Schema.is(Schema.Literals(PREVIEW_FIELDS))

/** The saved page as the preview endpoint takes it: only the monitors' history comes back used. */
export const previewDraftOf = (model: Model): Option.Option<StatusPagePreviewParams> =>
	Option.map(pageOf(model), (page) => ({
		name: page.name,
		slug: page.slug,
		components: Arr.map(componentsOf(model), (component) => ({
			name: component.name,
			group: component.group,
			monitor_id: component.monitor_id,
			manual_status: component.manual_status,
			show_uptime: component.show_uptime,
		})),
	}))

const schedulePreview = (model: Model): Return => {
	const generation = model.previewGeneration + 1
	return {
		model: { ...model, previewGeneration: generation },
		commands: [WaitEditorPreview({ generation })],
	}
}

// PANEL

/** A component closes once its unsaved edits are dealt with; the sheet hands focus back on its own. */
const closePanel = (model: Model): Return => {
	if (model.panel === null) return { model }
	return model.panel._tag === "Component"
		? leaveComponent(model, { _tag: "Close" })
		: { model: { ...model, panel: null } }
}

const sheetCommands = (step: ReturnType<typeof Dialog.update>) =>
	FoldkitCommand.mapMessages(step.commands ?? [], (message) => Message.GotPanelSheetMessage({ message }))

/** The open incident as listed, else the one the sheet last showed. */
const shownIncident = (model: Model): Model["sheetIncident"] => {
	const panel = model.panel
	if (panel?._tag !== "Incident") return model.sheetIncident
	return Option.getOrElse(
		Arr.findFirst(incidentsOf(model), (row) => row.id === panel.incidentId),
		() => model.sheetIncident,
	)
}

/**
 * Opens the sheet while an incident or Add is open and closes it otherwise, whatever opened them.
 * The sheet keeps showing the last of them, the incident as last listed, while it animates out.
 */
const withSheet = (result: Return): Return => {
	const isWanted = result.model.panel !== null && result.model.panel._tag !== "Component"
	const model = {
		...result.model,
		sheetPanel: isWanted ? result.model.panel : result.model.sheetPanel,
		sheetIncident: shownIncident(result.model),
	}
	if (isWanted === model.panelSheet.isOpen) return { ...result, model }
	const step = isWanted ? Dialog.open(model.panelSheet) : Dialog.close(model.panelSheet)
	return {
		...result,
		model: { ...model, panelSheet: step.model },
		commands: [...(result.commands ?? []), ...sheetCommands(step)],
	}
}

/** The sheet closed itself (Escape, backdrop, close button): what it showed closes with it. */
const updatePanelSheet = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.panelSheet, message)
	return {
		model: {
			...model,
			panelSheet: step.model,
			panel: step.outMessage?._tag === "Closed" ? null : model.panel,
		},
		commands: sheetCommands(step),
	}
}

/**
 * A click in the live page or a Settings preview opens what it landed on where it is edited; a
 * click under Monitors opens the component in place, and one on the header or footer reveals its
 * field.
 */
const selectFromPreview = (model: Model, kind: PreviewSelection["kind"], id: string): Return => {
	const navigate = (url: string) => PageOutMessage.RequestedNavigation({ url, isReplace: false })
	if (model.pageId === null) return { model }
	const here = resolveView(model.search)
	const isOnMonitors = here.tab === "settings" && here.section === "monitors"
	const pageId = model.pageId
	if (kind === "field") {
		if (!isPreviewField(id)) return { model }
		// The header and footer are page settings: open their section, at the field.
		const target = PREVIEW_FIELD_TARGETS[id]
		if (here.tab === "settings" && here.section === target.section)
			return { model, commands: [RevealEditorField({ id: target.id })] }
		return {
			model: { ...model, revealFieldId: target.id },
			outMessage: navigate(statusPageHref(pageId, "settings", target.section)),
		}
	}
	// A group's name is edited on its components: a click on it opens its first one.
	if (kind === "component" || kind === "group")
		return Option.match(
			Arr.findFirst(componentsOf(model), (row) => row.id === id),
			{
				onNone: () => ({ model }),
				onSome: (component) => {
					const opened = leaveComponent(model, {
						_tag: "Open",
						componentId: component.id,
						isRevealed: true,
					})
					if (isOnMonitors) return opened
					return { ...opened, outMessage: navigate(statusPageHref(pageId, "settings", "monitors")) }
				},
			},
		)
	return Option.match(
		Arr.findFirst(incidentsOf(model), (row) => row.id === id),
		{
			onNone: () => ({ model }),
			onSome: (incident) => ({
				...selectIncident(model, incident.id),
				outMessage: navigate(
					statusPageHref(pageId, incident.kind === "incident" ? "incidents" : "maintenance"),
				),
			}),
		},
	)
}

/** The "..." menu: links navigate, the rest are this page's own actions. */
const updatePageMenu = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.pageMenu, message)
	const commands = FoldkitCommand.mapMessages(result.commands ?? [], (child) =>
		Message.GotPageMenuMessage({ message: child }),
	)
	const next = { ...model, pageMenu: result.model }
	if (result.outMessage?._tag !== "SelectedItem" || model.pageId === null) return { model: next, commands }
	const navigate = (url: string): Return => ({
		model: next,
		commands,
		outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
	})
	switch (result.outMessage.value) {
		case OPEN_PUBLIC_VALUE:
			return Option.match(pageOf(next), {
				onNone: () => ({ model: next, commands }),
				onSome: (page): Return => {
					const link = publicPageLink(page, pageUrlOf(next, page))
					return link._tag === "Open"
						? { model: next, commands: [...commands, OpenPublicPage({ url: link.url })] }
						: { model: next, commands }
				},
			})
		case OPEN_PREVIEW_VALUE:
			return navigate(statusPageViewHref(model.pageId))
		case "break-glass":
			return navigate(
				`${statusPageHref(model.pageId, "settings", "advanced")}#status-page-settings-break-glass`,
			)
		case "delete":
			return deletePageDialog(next, Dialog.open(next.deletePageDialog))
		default:
			return { model: next, commands }
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	withSheet(step(model, message, context))

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		// Each fresh read re-reads the clock, so "published 2m ago" and update times never drift into the future.
		// The preview's history needs the page too: when the components came first, read it now.
		CompletedFetchPage: ({ key, result }) => {
			const next = { ...model, page: Keyed.accept(model.page, key, result) }
			const awaitsHistory =
				key === model.page.key &&
				Result.isSuccess(result) &&
				model.previewShown === 0 &&
				Option.isSome(AsyncData.getData(model.components.data))
			if (!awaitsHistory) return { model: next, commands: [ReadEditorClock()] }
			const scheduled = schedulePreview(next)
			return { model: scheduled.model, commands: [ReadEditorClock(), ...(scheduled.commands ?? [])] }
		},
		// New components mean new monitors to show history for: the preview reads it again.
		CompletedFetchComponents: ({ key, result }) => {
			const next = { ...model, components: Keyed.accept(model.components, key, result) }
			return key === model.components.key && Result.isSuccess(result)
				? schedulePreview(next)
				: { model: next }
		},
		CompletedFetchIncidents: ({ key, result }) => ({
			model: { ...model, incidents: Keyed.accept(model.incidents, key, result) },
			commands: [ReadEditorClock()],
		}),
		CompletedFetchConfig: ({ key, result }) => {
			const next = { ...model, config: Keyed.accept(model.config, key, result) }
			// Only a successful read the slot kept may rebase the draft; a superseded or failed one
			// carries older data, and the rebase waits for the next good read.
			return {
				model: key === model.config.key && Result.isSuccess(result) ? rebaseJsonDraft(next) : next,
			}
		},
		CompletedFetchMonitors: ({ key, result }) => ({
			model: { ...model, monitors: Keyed.accept(model.monitors, key, result) },
		}),
		CompletedFetchSession: (answer) => ({
			model: acceptGrants(model, context.orgId, answer, { isSessionLoaded: true }),
		}),
		ClickedRetry: () =>
			chain(
				model,
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
				readIncidents(context, "Supersede"),
				readMonitors(context, "Supersede"),
				readCustomDomain(context, "Supersede"),
				whenJson(context, "Supersede"),
			),
		GotPageMenuMessage: ({ message: child }) => updatePageMenu(model, child),
		CompletedOpenPublicPage: () => ({ model }),
		// A reveal happens once: a later remount of the same row (back from another section) stays put.
		CompletedFocus: () => ({ model: { ...model, revealComponentId: null } }),
		// Preview and selection
		ElapsedPreviewDebounce: ({ generation }) =>
			generation !== model.previewGeneration
				? { model }
				: Option.match(previewDraftOf(model), {
						onNone: () => ({ model }),
						onSome: (draft) => ({ model, commands: [FetchEditorPreview({ generation, draft })] }),
					}),
		// History is a nicety: a failed read keeps the last bars rather than blanking the page.
		CompletedFetchPreview: ({ generation, draft, result }) =>
			generation < model.previewShown
				? { model }
				: Result.match(result, {
						onFailure: (): Return => ({ model }),
						onSuccess: (snapshot): Return => ({
							model: {
								...model,
								previewShown: generation,
								previewHistory: historyFrom(draft, snapshot),
							},
						}),
					}),
		ReceivedPreviewSelection: ({ kind, id }) => selectFromPreview(model, kind, id),
		// A second click on the open component closes it.
		ClickedComponent: ({ componentId }) =>
			leaveComponent(
				model,
				model.panel?._tag === "Component" && model.panel.componentId === componentId
					? { _tag: "Close" }
					: { _tag: "Open", componentId, isRevealed: false },
			),
		ClickedIncident: ({ incidentId }) => selectIncident(model, incidentId),
		GotPanelSheetMessage: ({ message: child }) => updatePanelSheet(model, child),
		PressedEscape: () => closePanel(model),
		// Components
		ChangedComponentField: ({ field, value }) => changeComponent(model, field, value),
		ToggledComponentUptime: () => toggleComponentUptime(model),
		GotGroupPickerMessage: ({ message: child }) => groupPickerStep(model, child),
		ClickedSaveMonitors: () => saveMonitors(model),
		ClickedDiscardMonitors: () => discardMonitors(model),
		CompletedSaveComponent: ({ result }) => savedComponent(model, result, context),
		ClickedConfirmDiscardComponent: () => confirmDiscardComponent(model),
		GotDiscardComponentDialogMessage: ({ message: child }) =>
			discardComponentDialog(model, Dialog.update(model.discardComponentDialog, child)),
		DroppedComponent: ({ componentId, index }) => moveComponent(model, componentId, index),
		PressedMoveComponent: ({ componentId, offset }) => nudgeComponent(model, componentId, offset),
		DroppedGroup: ({ group, index }) => moveGroup(model, group, index),
		PressedMoveGroup: ({ group, offset }) => nudgeGroup(model, group, offset),
		CompletedReorder: ({ result }) => reordered(model, result, context),
		ClickedDeleteComponent: ({ componentId }) => askDeleteComponent(model, componentId),
		ClickedConfirmDeleteComponent: () => confirmDeleteComponent(model),
		CompletedDeleteComponent: ({ result }) => deletedComponent(model, result, context),
		GotDeleteComponentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingComponent, model, () =>
				deleteComponentDialog(model, Dialog.update(model.deleteComponentDialog, child)),
			),
		ClickedAddComponent: () => leaveComponent(model, { _tag: "Add" }),
		GotAddPickerMessage: ({ message: child }) => addPickerStep(model, child),
		CompletedCreateMonitor: ({ session, result }) => addMonitorCreated(model, session, result),
		CompletedTrackMonitorCreated: () => ({ model }),
		ClickedSubmitAdd: () => submitAdd(model),
		CompletedAddComponents: ({ session, result }) => addedComponents(model, session, result, context),
		// Incidents
		ClickedNewIncident: ({ kind }) => openComposer(model, kind),
		GotComposeDialogMessage: ({ message: child }) =>
			whenIdle(model.isCreatingIncident, model, () =>
				composeDialog(model, Dialog.update(model.composeDialog, child)),
			),
		ChangedIncidentKind: ({ kind }) => changeIncidentKind(model, kind),
		ChangedIncidentField: ({ field, value }) => changeIncident(model, field, value),
		ToggledIncidentComponent: ({ componentId }) => toggleIncidentComponent(model, componentId),
		ChangedIncidentAutoComplete: ({ autoComplete }) => ({
			model: { ...model, incidentForm: { ...model.incidentForm, autoComplete } },
		}),
		SubmittedIncidentWrite: () => reviewIncident(model, context),
		ClickedIncidentBack: () => backToIncidentWrite(model),
		SubmittedIncident: ({ isPublished }) => submitIncident(model, context, isPublished),
		CompletedCreateIncident: ({ result }) => createdIncident(model, result, context),
		ClickedPostUpdate: ({ incidentId, isResolving }) => openUpdate(model, incidentId, isResolving),
		GotUpdateDialogMessage: ({ message: child }) =>
			whenIdle(model.updateForm._tag === "Posting", model, () =>
				updateDialog(model, Dialog.update(model.updateDialog, child)),
			),
		ChangedUpdateField: ({ field, value }) => changeUpdate(model, field, value),
		SubmittedUpdateWrite: () => reviewUpdate(model, context),
		ClickedUpdateBack: () => backToUpdateWrite(model),
		SubmittedUpdate: () => submitUpdate(model, context),
		CompletedPostUpdate: ({ result }) => postedUpdate(model, result, context),
		ClickedPublishIncident: ({ incidentId }) => publishIncident(model, incidentId),
		CompletedPublishIncident: ({ incidentId, result }) =>
			publishedIncident(model, incidentId, result, context),
		ClickedEditIncident: ({ incidentId }) => openIncidentEdit(model, incidentId, context),
		GotEditIncidentDialogMessage: ({ message: child }) =>
			whenIdle(model.isSavingIncident, model, () =>
				editIncidentDialog(model, Dialog.update(model.editIncidentDialog, child)),
			),
		ChangedIncidentEditField: ({ field, value }) => changeIncidentEdit(model, field, value),
		ToggledIncidentEditComponent: ({ componentId }) => toggleIncidentEditComponent(model, componentId),
		ChangedIncidentEditAutoComplete: ({ autoComplete }) =>
			model.incidentEdit === null || model.isSavingIncident
				? { model }
				: { model: { ...model, incidentEdit: { ...model.incidentEdit, autoComplete } } },
		SubmittedIncidentEdit: () => submitIncidentEdit(model, context),
		CompletedSaveIncident: ({ result }) => savedIncident(model, result, context),
		ClickedDeleteIncident: ({ incidentId }) => askDeleteIncident(model, incidentId),
		ClickedConfirmDeleteIncident: () => confirmDeleteIncident(model),
		CompletedDeleteIncident: ({ result }) => deletedIncident(model, result, context),
		GotDeleteIncidentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingIncident, model, () =>
				deleteIncidentDialog(model, Dialog.update(model.deleteIncidentDialog, child)),
			),
		// Live
		GotUrlCopyMessage: ({ message: child }) => {
			const step = CopyButton.update(model.urlCopy, child)
			return {
				model: { ...model, urlCopy: step.model },
				commands: FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
					Message.GotUrlCopyMessage({ message: inner }),
				),
			}
		},
		// Settings
		ChangedSetting: ({ field, value }) => changeSetting(model, field, value),
		ToggledPoweredBy: () => togglePoweredBy(model),
		ClickedPickBrandingImage: ({ field }) => pickBrandingImage(model, field),
		CompletedPickBrandingImage: () => ({ model }),
		DraggedOverBrandingImage: ({ field }) => ({ model: { ...model, brandingDrag: field } }),
		LeftBrandingImage: () => ({ model: { ...model, brandingDrag: null } }),
		ClickedEditBrandingImage: ({ field }) => editBrandingImage(model, field),
		GotBrandingDialogMessage: ({ message: child }) =>
			brandingDialog(model, Dialog.update(model.brandingDialog, child)),
		ChangedBrandingLink: ({ value }) => ({ model: { ...model, brandingLink: value } }),
		SubmittedBrandingLink: () => submitBrandingLink(model),
		PickedBrandingImage: ({ field, files }) => takeBrandingImage(model, field, files),
		CompletedReadBrandingImage: ({ field, read, dataUrl }) => readBrandingImage(model, field, read, dataUrl),
		ClickedRemoveBrandingImage: ({ field }) => removeBrandingImage(model, field),
		PickedThemePreset: ({ preset }) =>
			changeTheme(model, { preset, ...STATUS_PAGE_PRESET_DEFAULTS[preset] }),
		PickedThemeAppearance: ({ appearance }) => changeTheme(model, { appearance }),
		ChangedThemeColor: ({ field, value }) => changeTheme(model, { [field]: value }),
		CompletedMountColorPicker: () => ({ model }),
		PickedThemeRadius: ({ radius }) => changeTheme(model, { radius }),
		PickedThemeFont: ({ font }) => changeTheme(model, { font }),
		PickedPreviewScheme: ({ scheme }) => ({ model: { ...model, previewScheme: scheme } }),
		PickedPreviewWidth: ({ width }) => ({ model: { ...model, previewWidth: width } }),
		PickedPreviewState: ({ state }) => ({ model: { ...model, previewState: state } }),
		ClickedDiscardSettings: () => ({
			model: { ...model, settingsEdits: null, settingsFailure: null, brandingRead: model.brandingRead + 1 },
		}),
		ClickedSaveSettings: () => saveSettings(model),
		// Basic settings' Save goes on to Who can view once the fields saved; a failure stops there.
		CompletedSaveSettings: ({ result }) => {
			const saved = savedSettings({ ...model, savesAccessNext: false }, result)
			if (!model.savesAccessNext || Result.isFailure(result)) return saved
			const access = saveAccess(saved.model)
			return { ...access, outMessage: access.outMessage ?? saved.outMessage }
		},
		ClickedPublish: () => publish(model),
		CompletedPublish: ({ result }) => published(model, result, context),
		ClickedRotateToken: () => askBreakGlass(model, "rotate"),
		ClickedRevokeToken: () => askBreakGlass(model, "revoke"),
		ClickedConfirmBreakGlass: () => runBreakGlass(model),
		CompletedRotateToken: ({ result }) => rotated(model, result, context),
		CompletedRevokeToken: ({ result }) => revoked(model, result),
		GotBreakGlassDialogMessage: ({ message: child }) =>
			whenIdle(model.isChangingBreakGlass, model, () =>
				breakGlassDialog(model, Dialog.update(model.breakGlassDialog, child)),
			),
		GotTokenCopyMessage: ({ message: child }) => updateTokenCopy(model, child),
		ClickedDismissToken: () => ({ model: { ...model, revealedToken: null } }),
		// Access
		PickedVisibility: ({ visibility }) => pickVisibility(model, visibility),
		ChangedPassword: ({ value }) => changePassword(model, value),
		ClickedDiscardAccess: () => discardAccess(model),
		ClickedSaveAccess: () => saveAccess(model),
		ClickedDiscardBasic: () => discardAccess({ ...model, settingsEdits: null, settingsFailure: null }),
		ClickedSaveBasic: () => {
			const settings = saveSettings(model)
			return settings.model.isSavingSettings
				? { ...settings, model: { ...settings.model, savesAccessNext: true } }
				: settings
		},
		CompletedAccessChange: ({ action, result }) => changedAccess(model, action, result),
		// Custom domain
		CompletedFetchCustomDomain: ({ key, result }) => ({
			model: { ...model, customDomain: Keyed.accept(model.customDomain, key, result) },
		}),
		ClickedRetryCustomDomain: () => readCustomDomain(context, "Refresh")(model),
		ChangedCustomDomain: ({ value }) => changeCustomDomain(model, value),
		SubmittedCustomDomain: () => submitCustomDomain(model),
		CompletedSetCustomDomain: ({ result }) => savedCustomDomain(model, result),
		ClickedCheckCustomDomain: () => checkCustomDomain(model),
		CompletedCheckCustomDomain: ({ result }) => checkedCustomDomain(model, result),
		ClickedRemoveCustomDomain: () =>
			removeCustomDomainDialog(model, Dialog.open(model.removeCustomDomainDialog)),
		ClickedConfirmRemoveCustomDomain: () => confirmRemoveCustomDomain(model),
		CompletedRemoveCustomDomain: ({ result }) => removedCustomDomain(model, result),
		GotRemoveCustomDomainDialogMessage: ({ message: child }) =>
			whenIdle(model.customDomainAction === "remove", model, () =>
				removeCustomDomainDialog(model, Dialog.update(model.removeCustomDomainDialog, child)),
			),
		GotDnsCopyMessage: ({ key, message: child }) => updateDnsCopy(model, key, child),
		// Page
		ClickedDeletePage: () => deletePageDialog(model, Dialog.open(model.deletePageDialog)),
		ClickedConfirmDeletePage: () => confirmDeletePage(model),
		CompletedDeletePage: ({ result }) => deletedPage(model, result),
		GotDeletePageDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingPage, model, () =>
				deletePageDialog(model, Dialog.update(model.deletePageDialog, child)),
			),
		// JSON
		ClickedEditJson: () => editJson(model),
		ChangedJson: ({ value }) => changeJson(model, value),
		ClickedResetJson: () => editJson(model),
		ClickedCancelJson: () => cancelJson(model),
		ClickedApplyJson: () => applyJson(model),
		CompletedApplyJson: ({ result }) => appliedJson(model, result, context),
		GotJsonCopyMessage: ({ message: child }) => updateJsonCopy(model, child),
	})
