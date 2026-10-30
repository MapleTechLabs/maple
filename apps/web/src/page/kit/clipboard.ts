import * as CopyButton from "../../ui/copy-button"
import { PageOutMessage } from "../contract"

/** `useCopy`'s write: the clipboard API, then the `execCommand` fallback; `true` when it landed. */
export const writeClipboard = CopyButton.writeClipboard

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
