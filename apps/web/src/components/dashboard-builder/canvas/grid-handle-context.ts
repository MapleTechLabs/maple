import { createContext, useContext } from "react"

/**
 * The id of the grid's keyboard instructions, for a drag handle's
 * `aria-describedby`. Undefined outside a grid (widget lab, previews), where
 * the handle does nothing.
 */
export const GridHandleContext = createContext<string | undefined>(undefined)

export function useGridHandleDescription(): string | undefined {
	return useContext(GridHandleContext)
}
