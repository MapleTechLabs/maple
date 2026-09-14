import { createContext, useContext } from "react"

/**
 * "Open the add-destination dialog" for whatever page owns the dialog. The
 * `/alerts` route provides it so the rules empty state (three components down,
 * behind the unitflow view) can offer the first destination inline instead of
 * sending the user off to another tab.
 */
const OpenDestinationDialogContext = createContext<(() => void) | null>(null)

export const OpenDestinationDialogProvider = OpenDestinationDialogContext.Provider

/** `null` where no dialog is mounted, so callers fall back to a link. */
export function useOpenDestinationDialog(): (() => void) | null {
	return useContext(OpenDestinationDialogContext)
}
