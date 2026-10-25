import { InfraSurfaceLiteral } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Frame from "../kit/frame"
import * as InstallModal from "../kit/install-modal"
import { SourceId, SourceReading } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchSource: {
		source: SourceId,
		key: Schema.String,
		result: Schema.Result(SourceReading, LoadFailure),
	},
	CompletedFetchPresence: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(InfraSurfaceLiteral), LoadFailure),
	},
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
})
export type Message = typeof Message.Type
