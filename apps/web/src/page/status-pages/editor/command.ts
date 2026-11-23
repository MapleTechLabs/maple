import { readClock } from "@maple/views/data/timing"
import {
	StatusPageComponentId,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageVisibility,
} from "@maple/domain"
import { UptimeMonitorKind } from "@maple/primitives"
import {
	StatusPageConfig,
	StatusPageDraftComponent,
	StatusPagePreviewParams,
	V2StatusPageComponentCreateParams,
	V2StatusPageIncidentCreateParams,
	V2StatusPageIncidentPostUpdateParams,
	V2StatusPageIncidentUpdateParams,
	V2StatusPageUpdateParams,
} from "@maple/domain/http/v2"
import { Duration, Effect, Schema } from "effect"
import { Command, Dom, File, Mount } from "foldkit"
import { clickFileInput } from "../../kit/image-dropzone"
import { imageSourceInputId } from "../../kit/image-source-field"
import { BrandingField } from "../shared/form"
import type { PreviewField } from "@maple/status-page"
import type { SettingsSection } from "../shared/commands"
import { trackProduct } from "../../../data/analytics"
import {
	applyPageConfig,
	checkCustomDomain,
	createIncident,
	deleteComponent,
	deleteIncident,
	deletePage,
	listComponents,
	listPageIncidents,
	postIncidentUpdate,
	previewPage,
	publishPage,
	removeCustomDomain,
	removePagePassword,
	reorderComponents,
	retrieveCustomDomain,
	retrievePage,
	retrievePageConfig,
	revokeBreakGlass,
	rotateBreakGlass,
	saveComponent,
	setCustomDomain,
	setPagePassword,
	updateIncident,
	updatePage,
	computeOrgKey,
} from "../shared/commands"
import { listMonitors, saveMonitor } from "../../kit/uptime/commands"
import { monitorPayloadFor } from "../shared/picker"
import { Message } from "./message"
import { fetchSessionGrants } from "../../kit/session-grants"

export const ReadEditorClock = readClock("ReadStatusPageClock", Message.ReadClock)

export const ComputeEditorOrgKey = computeOrgKey("ComputeStatusPageOrgKey", Message.ComputedOrgKey)

export const FetchEditorSession = fetchSessionGrants("FetchStatusPageSession", Message.CompletedFetchSession)

/** The public page in a new tab: a menu item has no `<a>` to carry `target="_blank"`. */
export const OpenPublicPage = Command.define("OpenStatusPublicPage", {
	args: { url: Schema.String },
	messages: [Message.CompletedOpenPublicPage],
	execute: ({ url }) =>
		Effect.sync(() => {
			window.open(url, "_blank", "noopener,noreferrer")
			return Message.CompletedOpenPublicPage()
		}),
})

export const FetchPage = Command.define("FetchStatusPage", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchPage],
	execute: ({ key, pageId }) =>
		retrievePage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPage({ key, result })),
		),
})

export const FetchComponents = Command.define("FetchStatusPageComponents", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchComponents],
	execute: ({ key, pageId }) =>
		listComponents(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchComponents({ key, result })),
		),
})

export const FetchIncidents = Command.define("FetchStatusPageIncidents", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchIncidents],
	execute: ({ key, pageId }) =>
		listPageIncidents(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchIncidents({ key, result })),
		),
})

export const FetchEditorMonitors = Command.define("FetchStatusPageMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

export const SaveComponent = Command.define("SaveStatusPageComponent", {
	args: {
		pageId: StatusPageId,
		componentId: Schema.NullOr(StatusPageComponentId),
		payload: V2StatusPageComponentCreateParams,
	},
	messages: [Message.CompletedSaveComponent],
	execute: ({ pageId, componentId, payload }) =>
		saveComponent(pageId, componentId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSaveComponent({ result })),
		),
})

export const ReorderComponents = Command.define("ReorderStatusPageComponents", {
	args: { pageId: StatusPageId, componentIds: Schema.Array(StatusPageComponentId) },
	messages: [Message.CompletedReorder],
	execute: ({ pageId, componentIds }) =>
		reorderComponents(pageId, componentIds).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedReorder({ result })),
		),
})

export const DeleteComponent = Command.define("DeleteStatusPageComponent", {
	args: { pageId: StatusPageId, componentId: StatusPageComponentId },
	messages: [Message.CompletedDeleteComponent],
	execute: ({ pageId, componentId }) =>
		deleteComponent(pageId, componentId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteComponent({ result })),
		),
})

export const CreateIncident = Command.define("CreateStatusPageIncident", {
	args: { payload: V2StatusPageIncidentCreateParams },
	messages: [Message.CompletedCreateIncident],
	execute: ({ payload }) =>
		createIncident(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateIncident({ result })),
		),
})

export const PostIncidentUpdate = Command.define("PostStatusPageIncidentUpdate", {
	args: {
		incidentId: StatusPageIncidentId,
		payload: V2StatusPageIncidentPostUpdateParams,
	},
	messages: [Message.CompletedPostUpdate],
	execute: ({ incidentId, payload }) =>
		postIncidentUpdate(incidentId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPostUpdate({ result })),
		),
})

export const PublishIncident = Command.define("PublishStatusPageIncident", {
	args: { incidentId: StatusPageIncidentId },
	messages: [Message.CompletedPublishIncident],
	execute: ({ incidentId }) =>
		updateIncident(incidentId, { published: true }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPublishIncident({ incidentId, result })),
		),
})

/** Saves an incident's title, impact and components; posts no update. */
export const SaveIncident = Command.define("SaveStatusPageIncident", {
	args: { incidentId: StatusPageIncidentId, payload: V2StatusPageIncidentUpdateParams },
	messages: [Message.CompletedSaveIncident],
	execute: ({ incidentId, payload }) =>
		updateIncident(incidentId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSaveIncident({ result })),
		),
})

export const DeleteIncident = Command.define("DeleteStatusPageIncident", {
	args: { incidentId: StatusPageIncidentId },
	messages: [Message.CompletedDeleteIncident],
	execute: ({ incidentId }) =>
		deleteIncident(incidentId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteIncident({ result })),
		),
})

export const SaveSettings = Command.define("SaveStatusPageSettings", {
	args: { pageId: StatusPageId, payload: V2StatusPageUpdateParams },
	messages: [Message.CompletedSaveSettings],
	execute: ({ pageId, payload }) =>
		updatePage(pageId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSaveSettings({ result })),
		),
})

export const PublishPage = Command.define("PublishStatusPage", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedPublish],
	execute: ({ pageId }) =>
		publishPage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedPublish({ result })),
		),
})

export const RotateToken = Command.define("RotateStatusPageBreakGlassToken", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedRotateToken],
	execute: ({ pageId }) =>
		rotateBreakGlass(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedRotateToken({ result })),
		),
})

export const RevokeToken = Command.define("RevokeStatusPageBreakGlassToken", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedRevokeToken],
	execute: ({ pageId }) =>
		revokeBreakGlass(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedRevokeToken({ result })),
		),
})

export const SaveVisibility = Command.define("SaveStatusPageVisibility", {
	args: { pageId: StatusPageId, visibility: StatusPageVisibility },
	messages: [Message.CompletedAccessChange],
	execute: ({ pageId, visibility }) =>
		updatePage(pageId, { visibility }).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedAccessChange({ action: "visibility", result })),
		),
})

/**
 * Built by hand, not with `Command.define`: a defined Command's args become its span's
 * attributes, and the password must not reach a trace.
 */
export const SetPassword = (pageId: StatusPageId, password: string) => ({
	name: "SetStatusPagePassword",
	effect: setPagePassword(pageId, password).pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedAccessChange({ action: "password", result })),
	),
})

export const RemovePassword = Command.define("RemoveStatusPagePassword", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedAccessChange],
	execute: ({ pageId }) =>
		removePagePassword(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedAccessChange({ action: "removePassword", result })),
		),
})

export const FetchConfig = Command.define("FetchStatusPageConfig", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchConfig],
	execute: ({ key, pageId }) =>
		retrievePageConfig(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchConfig({ key, result })),
		),
})

export const ApplyConfig = Command.define("ApplyStatusPageConfig", {
	args: { pageId: StatusPageId, config: StatusPageConfig, ifVersion: Schema.UndefinedOr(Schema.String) },
	messages: [Message.CompletedApplyJson],
	execute: ({ pageId, config, ifVersion }) =>
		applyPageConfig(pageId, config, ifVersion).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedApplyJson({ result })),
		),
})

export const DeletePage = Command.define("DeleteStatusPage", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedDeletePage],
	execute: ({ pageId }) =>
		deletePage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeletePage({ result })),
		),
})

/** How long the preview waits after the last change before it reads the monitors' history again. */
const PREVIEW_DEBOUNCE_MS = 400

export const WaitEditorPreview = Command.define("WaitStatusPageEditorPreview", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedPreviewDebounce],
	execute: ({ generation }) =>
		Effect.as(
			Effect.sleep(Duration.millis(PREVIEW_DEBOUNCE_MS)),
			Message.ElapsedPreviewDebounce({ generation }),
		),
})

export const FetchEditorPreview = Command.define("FetchStatusPageEditorPreview", {
	args: { generation: Schema.Number, draft: StatusPagePreviewParams },
	messages: [Message.CompletedFetchPreview],
	execute: ({ generation, draft }) =>
		previewPage(draft).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ generation, draft, result })),
		),
})

export const CreateEditorMonitor = Command.define("CreateStatusPageEditorMonitor", {
	args: { session: Schema.Number, url: Schema.String },
	messages: [Message.CompletedCreateMonitor],
	execute: ({ session, url }) =>
		saveMonitor(null, monitorPayloadFor(url)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateMonitor({ session, result })),
		),
})

/** A monitor created from the picker is the `uptime_monitor_created` product event. */
export const TrackMonitorCreated = Command.define("TrackStatusPageEditorMonitorCreated", {
	args: { kind: UptimeMonitorKind },
	messages: [Message.CompletedTrackMonitorCreated],
	execute: ({ kind }) =>
		trackProduct("uptime_monitor_created", { kind }).pipe(
			Effect.as(Message.CompletedTrackMonitorCreated()),
		),
})

/** Adds the picked components in order, one create each; the first failure stops the rest. */
export const AddComponents = Command.define("AddStatusPageComponents", {
	args: {
		session: Schema.Number,
		pageId: StatusPageId,
		components: Schema.Array(StatusPageDraftComponent),
	},
	messages: [Message.CompletedAddComponents],
	execute: ({ session, pageId, components }) =>
		Effect.forEach(components, (component) => saveComponent(pageId, null, component)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedAddComponents({ session, result })),
		),
})

export const FocusEditorElement = Command.define("FocusStatusPageEditorElement", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocus],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
})

/** The logo or favicon field's id; its hidden file input is `imageSourceInputId` of it. */
export const brandingFieldId = (field: BrandingField): string => `status-page-${field}`

/** Where each setting a preview click names is edited: its Settings section and the field's element id. */
export const PREVIEW_FIELD_TARGETS = {
	name: { section: "basic", id: "status-page-name" },
	logoUrl: { section: "appearance", id: brandingFieldId("logoUrl") },
	logoDarkUrl: { section: "appearance", id: brandingFieldId("logoDarkUrl") },
	websiteUrl: { section: "appearance", id: "status-page-website" },
	supportUrl: { section: "appearance", id: "status-page-support" },
	privacyUrl: { section: "appearance", id: "status-page-privacy" },
	termsUrl: { section: "appearance", id: "status-page-terms" },
	showPoweredBy: { section: "appearance", id: "status-page-powered-by" },
} as const satisfies Record<PreviewField, { section: SettingsSection; id: string }>

const FOCUSABLE =
	"input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])"

/**
 * Scrolls a field into view once its section is on screen, then focuses it, or its first control
 * when the id is on a wrapper. A read-only (disabled) field is only scrolled to.
 */
export const RevealEditorField = Command.define("RevealStatusPageEditorField", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocus],
	execute: ({ id }) =>
		Dom.scrollIntoViewAfterPaint(`#${CSS.escape(id)}`, { block: "center" }).pipe(
			Effect.andThen(
				Effect.sync(() => {
					const element = document.getElementById(id)
					const control = element?.matches(FOCUSABLE) ? element : element?.querySelector(FOCUSABLE)
					if (control instanceof HTMLElement) control.focus({ preventScroll: true })
				}),
			),
			Effect.ignore,
			Effect.as(Message.CompletedFocus()),
		),
})

/** Scrolls a component opened from the page preview into view as its row mounts. */
export const RevealOpenComponent = Mount.define("RevealStatusPageComponent", {
	messages: [Message.CompletedFocus],
	execute: ({ element }) =>
		Effect.sync(() => element.scrollIntoView({ block: "nearest" })).pipe(
			Effect.as(Message.CompletedFocus()),
		),
})

/** Focuses the element as it mounts, in the same render, so no keystroke lands elsewhere first. */
export const FocusNewRow = Mount.define("FocusStatusPageEditorRow", {
	messages: [Message.CompletedFocus],
	execute: ({ element }) =>
		Effect.sync(() => (element instanceof HTMLElement ? element.focus() : undefined)).pipe(
			Effect.as(Message.CompletedFocus()),
		),
})

export const FetchCustomDomain = Command.define("FetchStatusPageCustomDomain", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchCustomDomain],
	execute: ({ key, pageId }) =>
		retrieveCustomDomain(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCustomDomain({ key, result })),
		),
})

export const SetCustomDomain = Command.define("SetStatusPageCustomDomain", {
	args: { pageId: StatusPageId, hostname: Schema.String },
	messages: [Message.CompletedSetCustomDomain],
	execute: ({ pageId, hostname }) =>
		setCustomDomain(pageId, hostname).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSetCustomDomain({ result })),
		),
})

export const CheckCustomDomain = Command.define("CheckStatusPageCustomDomain", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedCheckCustomDomain],
	execute: ({ pageId }) =>
		checkCustomDomain(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCheckCustomDomain({ result })),
		),
})

export const RemoveCustomDomain = Command.define("RemoveStatusPageCustomDomain", {
	args: { pageId: StatusPageId },
	messages: [Message.CompletedRemoveCustomDomain],
	execute: ({ pageId }) =>
		removeCustomDomain(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedRemoveCustomDomain({ result })),
		),
})

export const PickBrandingImage = Command.define("PickStatusPageBrandingImage", {
	args: { field: BrandingField },
	messages: [Message.CompletedPickBrandingImage],
	execute: ({ field }) =>
		clickFileInput(imageSourceInputId(brandingFieldId(field))).pipe(
			Effect.as(Message.CompletedPickBrandingImage()),
		),
})

/** Reads a picked logo or favicon as the `data:` URL the page stores. */
export const ReadBrandingImage = Command.define("ReadStatusPageBrandingImage", {
	args: { field: BrandingField, read: Schema.Number, file: File.File },
	messages: [Message.CompletedReadBrandingImage],
	execute: ({ field, read, file }) =>
		File.readAsDataUrl(file).pipe(
			Effect.map((dataUrl) => Message.CompletedReadBrandingImage({ field, read, dataUrl })),
			Effect.orElseSucceed(() => Message.CompletedReadBrandingImage({ field, read, dataUrl: null })),
		),
})
