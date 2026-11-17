import { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadOutcome } from "../../kit/load-schemas"
import { PreviewScheme, PreviewState, PreviewWidth } from "../shared/preview"

export const Message = defineMessageUnion({
	CompletedFetchView: { key: Schema.String, result: LoadOutcome(StatusPagePublicSnapshot) },
	ClickedRetry: {},
	PickedPreviewState: { state: PreviewState },
	PickedPreviewWidth: { width: PreviewWidth },
	PickedPreviewScheme: { scheme: PreviewScheme },
})
export type Message = typeof Message.Type
