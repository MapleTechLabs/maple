import type { Html, HtmlBuilder } from "foldkit/html"
import type * as CopyButton from "@maple/views/ui/copy-button"
import { copyableField } from "@maple/views/ui/copyable-field"
import { typography } from "@maple/views/ui/typography"

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
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Store this key in a secure location. It will not be shown again.",
			]),
		],
	)
