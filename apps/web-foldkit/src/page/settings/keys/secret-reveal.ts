import type { Html, HtmlBuilder } from "foldkit/html"
import type * as CopyButton from "../../../ui/copy-button"
import { copyableField } from "../../../ui/copyable-field"

// `ApiKeySecretReveal`.

export type SecretRevealOptions<M> = Readonly<{
	id: string
	secret: string
	copy: CopyButton.Model
	toCopyMessage: (message: CopyButton.Message) => M
	isVisible: boolean
	onToggle: M
}>

export const secretReveal = <M>(h: HtmlBuilder<M>, options: SecretRevealOptions<M>): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			copyableField(h, {
				id: options.id,
				value: options.secret,
				copyLabel: "API key",
				copy: options.copy,
				toCopyMessage: options.toCopyMessage,
				masked: { isVisible: options.isVisible, onToggle: options.onToggle },
			}),
			h.p(
				[h.Class("text-muted-foreground text-xs")],
				["Store this key in a secure location. It will not be shown again."],
			),
		],
	)
