import type { StatusPagePreviewParams } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { AppRoute } from "../../../route"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { type PageContext, PageOutMessage } from "../../contract"
import {
	type EditorView,
	pageIdFromUrl,
	publicUrl,
	STATUS_PAGE_BASE_URL,
	statusPageHref,
} from "../shared/commands"
import { emptyComponentForm, emptyIncidentForm } from "../shared/form"
import { emptyPicker } from "../shared/picker"
import { historyFrom } from "../shared/preview"
import {
	FetchEditorPreview,
	FetchEditorSession,
	FocusEditorElement,
	OpenPublicPage,
	ReadEditorClock,
	WaitEditorPreview,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	componentsOf,
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
	commitComponent,
	confirmDeleteComponent,
	deleteComponentDialog,
	deletedComponent,
	moveComponent,
	openAdd,
	reordered,
	savedComponent,
	selectComponent,
	submitAdd,
} from "./update-components"
import {
	changeIncident,
	changeUpdate,
	createdIncident,
	changeIncidentKind,
	openComposer,
	openUpdate,
	postedUpdate,
	publishedIncident,
	publishIncident,
	selectIncident,
	submitIncident,
	submitUpdate,
	toggleIncidentComponent,
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
	changeTheme,
	updateTokenCopy,
} from "./update-settings"
import {
	appliedJson,
	applyJson,
	cancelJson,
	changeJson,
	editJson,
	rebaseJsonDraft,
	updateJsonCopy,
} from "./update-json"

type EditorRoute = Extract<AppRoute, { readonly _tag: "StatusPage" }>

/** The view the search names; anything else is the page itself, so an old or mistyped link lands. */
export const resolveView = (view: string | undefined): EditorView | "page" =>
	view === "settings" || view === "json" || view === "live" ? view : "page"

export const PAGE_MENU_ID = "status-page-menu"

export const init = (route: EditorRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		rawPageId: route.pageId,
		pageId: Option.getOrNull(pageIdFromUrl(route.pageId)),
		nowMs: null,
		page: Keyed.idle(),
		components: Keyed.idle(),
		incidents: Keyed.idle(),
		config: Keyed.idle(),
		monitors: Keyed.idle(),
		isAdmin: false,
		isSessionLoaded: false,
		pageMenu: Menu.init(PAGE_MENU_ID),
		panel: null,
		previewScheme: "light",
		previewGeneration: 0,
		previewShown: 0,
		previewHistory: [],
		componentForm: emptyComponentForm,
		componentSave: "idle",
		componentFailure: null,
		confirmDeleteComponentId: null,
		deleteComponentDialog: Dialog.init("status-page-delete-component", "alert-dialog"),
		isDeletingComponent: false,
		isReordering: false,
		addPicker: emptyPicker,
		isAddingComponents: false,
		incidentForm: emptyIncidentForm("incident"),
		isCreatingIncident: false,
		incidentFailure: null,
		updateForm: null,
		isPostingUpdate: false,
		updateFailure: null,
		publishingIncidentIds: [],
		publicBaseUrl: STATUS_PAGE_BASE_URL,
		urlCopy: CopyButton.init(),
		settingsEdits: null,
		isSavingSettings: false,
		settingsFailure: null,
		isPublishing: false,
		breakGlassDialog: Dialog.init("status-page-break-glass", "alert-dialog"),
		breakGlassAction: null,
		isChangingBreakGlass: false,
		revealedToken: null,
		tokenCopy: CopyButton.init(),
		deletePageDialog: Dialog.init("status-page-delete", "alert-dialog"),
		isDeletingPage: false,
		jsonDraft: null,
		jsonBase: null,
		isRebasingJson: false,
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

/** The config read, only while the JSON view is open: the document must be current when edited. */
const whenJson =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return =>
		resolveView(model.search.view) === "json" ? readConfig(context, mode)(model) : { model }

/** A view switch is a search change; opening JSON re-reads the config, since other views write too. */
export const routeChanged = (model: Model, route: EditorRoute, context: PageContext): Return =>
	whenJson(context, "Refresh")({ ...model, search: route.search, panel: null })

/** The dialogs ignore dismissal while their write is in flight, as `ConfirmDialog` does. */
const whenIdle = (isBusy: boolean, model: Model, run: () => Return): Return => (isBusy ? { model } : run())

// PREVIEW

/** The saved page as the preview endpoint takes it: only the monitors' history comes back used. */
export const previewDraftOf = (model: Model): Option.Option<StatusPagePreviewParams> =>
	Option.map(pageOf(model), (page) => ({
		name: page.name,
		slug: page.slug,
		components: componentsOf(model).map((component) => ({
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

/** Closing hands focus back to the row that opened the panel, or the list. */
const closePanel = (model: Model): Return => {
	const panel = model.panel
	const target =
		panel?._tag === "Component"
			? `status-page-item-${panel.componentId}`
			: panel?._tag === "Incident"
				? `status-page-item-${panel.incidentId}`
				: "status-page-on-this-page"
	return panel === null
		? { model }
		: {
				model: { ...model, panel: null, updateForm: null },
				commands: [FocusEditorElement({ id: target })],
			}
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
		case "settings":
			return navigate(statusPageHref(model.pageId, "settings"))
		case "json":
			return navigate(statusPageHref(model.pageId, "json"))
		case "break-glass":
			return navigate(`${statusPageHref(model.pageId, "settings")}#status-page-settings-break-glass`)
		case "delete":
			return deletePageDialog(next, Dialog.open(next.deletePageDialog))
		case "public":
			return Option.match(
				Option.flatMap(pageOf(model), (page) =>
					Option.fromNullishOr(publicUrl(model.publicBaseUrl, page.slug)),
				),
				{
					onNone: () => ({ model: next, commands }),
					onSome: (url) => ({ model: next, commands: [...commands, OpenPublicPage({ url })] }),
				},
			)
		default:
			return { model: next, commands }
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		// Each fresh read re-reads the clock, so "published 2m ago" and update times never drift into the future.
		CompletedFetchPage: ({ key, result }) => ({
			model: { ...model, page: Keyed.accept(model.page, key, result) },
			commands: [ReadEditorClock()],
		}),
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
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin, isSessionLoaded: true } } : { model },
		ClickedRetry: () =>
			chain(
				model,
				readPage(context, "Supersede"),
				readComponents(context, "Supersede"),
				readIncidents(context, "Supersede"),
				readMonitors(context, "Supersede"),
				whenJson(context, "Supersede"),
			),
		GotPageMenuMessage: ({ message: child }) => updatePageMenu(model, child),
		CompletedFocus: () => ({ model }),
		OpenedPublicPage: () => ({ model }),
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
		ReceivedPreviewSelection: ({ kind, id }) => {
			const component = componentsOf(model).find((row) => row.id === id)
			return kind === "component"
				? component === undefined
					? { model }
					: selectComponent(model, component.id)
				: Option.match(
						Option.fromNullishOr(
							AsyncData.getOrElse(model.incidents.data, () => []).find((row) => row.id === id),
						),
						{
							onNone: () => ({ model }),
							onSome: (incident) => selectIncident(model, incident.id),
						},
					)
		},
		ClickedComponent: ({ componentId }) => selectComponent(model, componentId),
		ClickedIncident: ({ incidentId }) => selectIncident(model, incidentId),
		ClickedClosePanel: () => closePanel(model),
		// Escape skips the field's blur, so a component panel saves its typed edits before it closes.
		PressedEscape: () =>
			model.panel?._tag === "Component" ? chain(model, commitComponent, closePanel) : closePanel(model),
		// Components
		ChangedComponentField: ({ field, value }) => changeComponent(model, field, value),
		CommittedComponent: () => commitComponent(model),
		PickedComponentField: ({ field, value }) =>
			commitComponent(changeComponent(model, field, value).model),
		ToggledComponentUptime: () =>
			commitComponent({
				...model,
				componentForm: { ...model.componentForm, showUptime: !model.componentForm.showUptime },
			}),
		CompletedSaveComponent: ({ result }) => savedComponent(model, result, context),
		ClickedMoveComponent: ({ componentId, offset }) => moveComponent(model, componentId, offset),
		CompletedReorder: ({ result }) => reordered(model, result, context),
		ClickedDeleteComponent: ({ componentId }) => askDeleteComponent(model, componentId),
		ClickedConfirmDeleteComponent: () => confirmDeleteComponent(model),
		CompletedDeleteComponent: ({ result }) => deletedComponent(model, result, context),
		GotDeleteComponentDialogMessage: ({ message: child }) =>
			whenIdle(model.isDeletingComponent, model, () =>
				deleteComponentDialog(model, Dialog.update(model.deleteComponentDialog, child)),
			),
		ClickedAddComponent: () => openAdd(model),
		GotAddPickerMessage: ({ message: child }) => addPickerStep(model, child),
		CompletedCreateMonitor: ({ result }) => addMonitorCreated(model, result),
		ClickedSubmitAdd: () => submitAdd(model),
		CompletedAddComponents: ({ result }) => addedComponents(model, result, context),
		// Incidents
		ClickedNewIncident: ({ kind }) => openComposer(model, kind),
		ChangedIncidentKind: ({ kind }) => changeIncidentKind(model, kind),
		ChangedIncidentField: ({ field, value }) => changeIncident(model, field, value),
		ToggledIncidentComponent: ({ componentId }) => toggleIncidentComponent(model, componentId),
		PickedIncidentPublished: ({ isPublished }) => ({
			model: { ...model, incidentForm: { ...model.incidentForm, isPublished } },
		}),
		SubmittedIncident: () => submitIncident(model, context),
		CompletedCreateIncident: ({ result }) => createdIncident(model, result, context),
		ClickedPostUpdate: ({ incidentId, isResolving }) => openUpdate(model, incidentId, isResolving),
		ChangedUpdateField: ({ field, value }) => changeUpdate(model, field, value),
		SubmittedUpdate: () => submitUpdate(model),
		ClickedCancelUpdate: () => ({ model: { ...model, updateForm: null, updateFailure: null } }),
		CompletedPostUpdate: ({ result }) => postedUpdate(model, result, context),
		ClickedPublishIncident: ({ incidentId }) => publishIncident(model, incidentId),
		CompletedPublishIncident: ({ incidentId, result }) =>
			publishedIncident(model, incidentId, result, context),
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
		PickedThemePreset: ({ preset }) => changeTheme(model, { preset }),
		PickedThemeAppearance: ({ appearance }) => changeTheme(model, { appearance }),
		ChangedThemeColor: ({ field, value }) => changeTheme(model, { [field]: value }),
		PickedThemeRadius: ({ radius }) => changeTheme(model, { radius }),
		PickedThemeFont: ({ font }) => changeTheme(model, { font }),
		PickedPreviewScheme: ({ scheme }) => ({ model: { ...model, previewScheme: scheme } }),
		ClickedDiscardSettings: () => ({ model: { ...model, settingsEdits: null, settingsFailure: null } }),
		ClickedSaveSettings: () => saveSettings(model),
		CompletedSaveSettings: ({ result }) => savedSettings(model, result),
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
