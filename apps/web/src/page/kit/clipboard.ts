import { PageOutMessage } from "../contract"
import { String as Str } from "effect"

/** The toast for a finished copy (no label: the generic titles). */
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
					title: label ? `Couldn't copy ${Str.toLowerCase(label)}` : "Couldn't copy",
					description: "",
				},
	)
