import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { formDialogForm } from "@maple/views/ui/form-dialog"
import * as FeatureRequest from "../kit/feature-request"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const COPY: FeatureRequest.Copy = {
	subjectLabel: "Provider",
	subjectPlaceholder: "Hetzner, Datadog, Snowflake…",
	noteLabel: "What would you want to see? (optional)",
	noteHint: "For example the products, projects or accounts you would split the cost by.",
}

const toParent = (message: FeatureRequest.Message) => Message.GotRequestMessage({ message })

/**
 * The dialog's request step: the provider someone wants Maple to read cost from, and why. Opened
 * from the providers, with the search that found nothing as the provider.
 */
export const requestStep = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
	const request = model.request
	return [
		formDialogForm(
			h,
			FeatureRequest.canSubmit(request) ? toParent(FeatureRequest.Message.Submitted()) : undefined,
			[
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, "Request a provider"),
					DialogView.dialogDescription(
						h,
						"dialog",
						id,
						"Tell us where else your money goes. Requests decide which source Maple reads next.",
					),
				]),
				DialogView.dialogPanel(h, "dialog", id, [
					FeatureRequest.fields(h, request, { idPrefix: "cost-request", copy: COPY, toParent }),
				]),
				DialogView.dialogFooter(h, "dialog", [
					button(
						h,
						{
							variant: "outline",
							isDisabled: request.isSending,
							attributes: [h.OnClick(Message.ClickedBackToProviders())],
						},
						["Back"],
					),
					button(
						h,
						{
							type: "submit",
							isLoading: request.isSending,
							isDisabled: !FeatureRequest.canSubmit(request),
						},
						["Send request"],
					),
				]),
			],
		),
	]
}
