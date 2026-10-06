import { toastManager } from "@maple/ui/components/ui/toast"
import { Exit } from "effect"
import { displayError, isUnexpectedError } from "./error-messages"

interface ShowErrorToastOptions {
	readonly title?: string
	readonly fallbackTitle?: string
	readonly type?: "error" | "warning"
}

/** Keeps raw Cause/Exit/error messages in telemetry rather than UI copy. */
export const showErrorToast = (error: unknown, options: ShowErrorToastOptions = {}): void => {
	const presentation = displayError(error)
	toastManager.add({
		title:
			options.title ??
			(isUnexpectedError(presentation)
				? (options.fallbackTitle ?? presentation.title)
				: presentation.title),
		description: presentation.message,
		type: options.type ?? "error",
	})
}

export const errorMessage = (error: unknown, fallback: string): string => {
	const presentation = displayError(error)
	return isUnexpectedError(presentation) ? fallback : presentation.message
}

interface ToastExitOptions {
	/** Toast title on success; omit to stay silent on success. */
	readonly success?: string
	/** Toast title on failure; the description is the error's user-facing message. */
	readonly error: string
}

/**
 * Toasts the outcome of a `promise(Exit)` mutation and returns whether it succeeded, so a call
 * site reads `if (toastExit(await save(...), { success: "Saved", error: "Couldn't save" })) close()`.
 */
export function toastExit(exit: Exit.Exit<unknown, unknown>, options: ToastExitOptions): boolean {
	if (Exit.isSuccess(exit)) {
		if (options.success !== undefined) toastManager.add({ title: options.success, type: "success" })
		return true
	}
	showErrorToast(exit, { title: options.error })
	return false
}
