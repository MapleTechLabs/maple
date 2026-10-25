import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { ApiBucket, EndpointDetail } from "../model-tabs"

export const Step = Schema.Literals([1, -1])
export type Step = typeof Step.Type

export const Message = defineMessageUnion({
	CompletedFetchDetail: {
		spanName: Schema.String,
		key: Schema.String,
		result: Schema.Result(EndpointDetail, LoadFailure),
	},
	CompletedFetchSeries: {
		spanName: Schema.String,
		key: Schema.String,
		result: Schema.Result(Schema.Array(ApiBucket), LoadFailure),
	},
	ClickedStep: { step: Step },
	/** `MountPeekKeys`: down/J forward, up/K back. */
	PressedStepKey: { step: Step },
	ClickedRetryDetail: {},
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	GotDialogMessage: { message: Dialog.Message },
})
export type Message = typeof Message.Type

/** What the table acts on: a step walks its rows, a close clears `endpoint` from the URL. */
export const OutMessage = defineMessageUnion({
	RequestedStep: { step: Step },
	Closed: {},
})
export type OutMessage = typeof OutMessage.Type
