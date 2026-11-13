import type { Html, HtmlBuilder } from "foldkit/html"
import { answerTrail } from "@maple/views/ui/answer-trail"
import type { Message } from "./message"

// The add-source dialog's progress: the provider picked, then connecting it.

/** `provider` is null on the picker. */
export const addTrail = (h: HtmlBuilder<Message>, provider: string | null): Html =>
	answerTrail(h, {
		label: "Add source progress",
		steps:
			provider === null
				? [
						{ label: "Provider", state: "current" },
						{ label: "Connect", state: "next" },
					]
				: [
						// Not a button: the dialog's first focus belongs to its field, and Back is in the footer.
						{ label: "Provider", state: "done", answer: provider },
						{ label: "Connect", state: "current" },
					],
	})
