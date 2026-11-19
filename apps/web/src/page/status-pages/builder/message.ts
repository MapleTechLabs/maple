import {
	StatusPagePreviewParams,
	V2StatusPage,
	V2StatusPageCustomDomain,
	V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	StatusPagePublicSnapshot,
	StatusPageThemeAppearance,
	StatusPageThemePreset,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "@maple/views/ui/combobox"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import { ComponentTextField } from "../shared/form"
import { PickerMessage } from "../shared/picker"
import { PreviewScheme } from "../shared/preview"
import { SubmitMode } from "./model"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: SessionGrants,
	CompletedFetchMonitors: { key: Schema.String, result: LoadOutcome(Schema.Array(V2UptimeMonitor)) },
	ClickedRetry: {},
	GotPromptCopyMessage: { message: CopyButton.Message },
	GotMcpCommandCopyMessage: { message: CopyButton.Message },
	ChangedName: { value: Schema.String },
	BlurredName: {},
	ChangedSlug: { value: Schema.String },
	ChangedCustomDomain: { value: Schema.String },
	/** A row's head: opens it in place, or closes it when open. */
	ClickedRow: { key: Schema.String },
	ChangedRowField: { field: ComponentTextField, value: Schema.String },
	ToggledRowUptime: {},
	GotGroupPickerMessage: { message: Combobox.Message },
	ClickedRemoveRow: { key: Schema.String },
	/** A grip drag let go over `index`, the slot within the row's group. */
	DroppedRow: { key: Schema.String, index: Schema.Number },
	/** A group's grip let go over `index` among the groups (`null` is "No group"). */
	DroppedGroup: { group: Schema.NullOr(Schema.String), index: Schema.Number },
	/** ArrowUp (-1) or ArrowDown (1) on a group's grip. */
	PressedMoveGroup: { group: Schema.NullOr(Schema.String), offset: Schema.Number },
	/** ArrowUp (-1) or ArrowDown (1) on a row's grip. */
	PressedMoveRow: { key: Schema.String, offset: Schema.Number },
	ClickedAddComponents: {},
	GotAddSheetMessage: { message: Dialog.Message },
	GotAddPickerMessage: { message: PickerMessage },
	ClickedSubmitAdd: {},
	CompletedCreateMonitor: { result: LoadOutcome(V2UptimeMonitor) },
	CompletedFocus: {},
	PickedPreset: { preset: StatusPageThemePreset },
	PickedAppearance: { appearance: StatusPageThemeAppearance },
	PickedPreviewScheme: { scheme: PreviewScheme },
	ElapsedPreviewDebounce: { generation: Schema.Number },
	CompletedFetchPreview: {
		generation: Schema.Number,
		draft: StatusPagePreviewParams,
		result: LoadOutcome(StatusPagePublicSnapshot),
	},
	ClickedSubmit: { mode: SubmitMode },
	CompletedCreate: { mode: SubmitMode, result: LoadOutcome(V2StatusPage) },
	/** The custom domain asked for, set on the page just created. */
	CompletedSetCustomDomain: { page: V2StatusPage, result: LoadOutcome(V2StatusPageCustomDomain) },
	/** A `trackProduct` call was handed to the session SDK. */
	CompletedTrackProduct: {},
})
export type Message = typeof Message.Type
