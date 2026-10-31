import { StatusPagePreviewParams, V2StatusPage, V2UptimeMonitor } from "@maple/domain/http/v2"
import {
	StatusPageSnapshot,
	StatusPageThemeAppearance,
	StatusPageThemePreset,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import { PickerMessage } from "../shared/picker"
import { PreviewScheme } from "../shared/preview"
import { SubmitMode } from "./model"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	CompletedFetchMonitors: { key: Schema.String, result: outcome(Schema.Array(V2UptimeMonitor)) },
	ClickedRetry: {},
	ChangedName: { value: Schema.String },
	BlurredName: {},
	ChangedSlug: { value: Schema.String },
	GotPickerMessage: { message: PickerMessage },
	CompletedCreateMonitor: { result: outcome(V2UptimeMonitor) },
	CompletedFocus: {},
	PickedPreset: { preset: StatusPageThemePreset },
	PickedAppearance: { appearance: StatusPageThemeAppearance },
	PickedPreviewScheme: { scheme: PreviewScheme },
	ElapsedPreviewDebounce: { generation: Schema.Number },
	CompletedFetchPreview: {
		generation: Schema.Number,
		draft: StatusPagePreviewParams,
		result: outcome(StatusPageSnapshot),
	},
	ClickedSubmit: { mode: SubmitMode },
	CompletedCreate: { mode: SubmitMode, result: outcome(V2StatusPage) },
})
export type Message = typeof Message.Type
