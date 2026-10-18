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

/** `useCopy({ label, successMessage })`'s toast for a finished copy. */
export const copyToast = (label: string, isOk: boolean, successMessage?: string) =>
	PageOutMessage.RequestedToast(
		isOk
			? { type: "success", title: successMessage ?? `${label} copied`, description: "" }
			: { type: "error", title: `Failed to copy ${label.toLowerCase()}`, description: "" },
	)
