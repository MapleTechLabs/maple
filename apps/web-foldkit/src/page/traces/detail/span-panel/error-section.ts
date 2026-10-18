import { parseErrorBody } from "@maple/ui/lib/error-body"
import { formatErrorPrompt } from "@maple/ui/lib/error-prompt"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorSectionView } from "../../../../ui/error-section"
import { statusOf } from "./copy"
import { Message } from "./message"
import type { Model } from "./model"

// `ErrorSection` (packages/ui/src/components/error-section.tsx) for a span, with a "Copy as prompt" payload.

type H = HtmlBuilder<Message>

export type ErrorSectionInput = Readonly<{
	message: string
	prompt: Readonly<{ serviceName: string; operation: string; attributes: Readonly<Record<string, string>> }>
}>

const BODY_ID = "error-body"
const PROMPT_ID = "error-prompt"

export const errorSection = (h: H, model: Model, input: ErrorSectionInput): Html => {
	const { message } = input
	return errorSectionView(h, {
		message,
		isExpanded: model.isErrorExpanded,
		onToggle: Message.ToggledErrorExpanded(),
		bodyStatus: statusOf(model, BODY_ID),
		onCopyBody: Message.ClickedCopy({ id: BODY_ID, text: parseErrorBody(message).full }),
		prompt: {
			status: statusOf(model, PROMPT_ID),
			tooltipId: "span-panel-error-prompt",
			onCopy: Message.ClickedCopy({
				id: PROMPT_ID,
				text: formatErrorPrompt({
					message,
					serviceName: input.prompt.serviceName,
					operation: input.prompt.operation,
					attributes: { ...input.prompt.attributes },
				}),
			}),
		},
	})
}
