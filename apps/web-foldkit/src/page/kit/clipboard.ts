import { writeClipboardFallback } from "@maple/ui/lib/clipboard"
import { Effect } from "effect"
import { PageOutMessage } from "../contract"

/** `useCopy`'s write: the clipboard API, then the `execCommand` fallback; `true` when it landed. */
export const writeClipboard = (text: string): Effect.Effect<boolean> =>
	Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.try(() => writeClipboardFallback(text))),
		Effect.orElseSucceed(() => false),
	)

/** `useCopy({ label, successMessage })`'s toast for a finished copy (no label: the generic titles). */
export const copyToast = (label: string | undefined, isOk: boolean, successMessage?: string) =>
	PageOutMessage.RequestedToast(
		isOk
			? {
					type: "success",
					title: successMessage ?? (label ? `${label} copied` : "Copied to clipboard"),
					description: "",
				}
			: {
					type: "error",
					title: label ? `Failed to copy ${label.toLowerCase()}` : "Failed to copy",
					description: "",
				},
	)
