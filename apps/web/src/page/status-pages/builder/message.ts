import { StatusPagePreviewParams, V2StatusPage, V2UptimeMonitor } from "@maple/domain/http/v2"
import {
	StatusPageSnapshot,
	StatusPageThemeAppearance,
	StatusPageThemePreset,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
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
	ChangedName: { value: Schema.String },
	BlurredName: {},
	ChangedSlug: { value: Schema.String },
	GotPickerMessage: { message: PickerMessage },
	CompletedCreateMonitor: { result: LoadOutcome(V2UptimeMonitor) },
	CompletedFocus: {},
	PickedPreset: { preset: StatusPageThemePreset },
	PickedAppearance: { appearance: StatusPageThemeAppearance },
	PickedPreviewScheme: { scheme: PreviewScheme },
	ElapsedPreviewDebounce: { generation: Schema.Number },
	CompletedFetchPreview: {
		generation: Schema.Number,
		draft: StatusPagePreviewParams,
		result: LoadOutcome(StatusPageSnapshot),
	},
	ClickedSubmit: { mode: SubmitMode },
	CompletedCreate: { mode: SubmitMode, result: LoadOutcome(V2StatusPage) },
})
export type Message = typeof Message.Type
