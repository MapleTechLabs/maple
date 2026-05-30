"use client"

import * as React from "react"

/**
 * Cross-cutting configuration for the shared attribute renderers
 * (`CopyableValue`, `CollapsibleJsonValue`, `AttributesTable`, `LogAttributeChip`).
 *
 * Both are optional so `@maple/ui` stays free of app-level deps (sonner,
 * sugar-high). Apps wire them once at the root via `AttributesProvider`:
 *   - `notifyCopied` surfaces copy feedback (e.g. a toast). Called after the
 *     value lands on the clipboard; the optional message lets callers customize
 *     it (the chip copies `key=value` and passes `Copied <key>`).
 *   - `highlightJson` turns a JSON string into highlighted HTML. When omitted,
 *     JSON renders as plain pre-formatted text.
 */
export interface AttributesConfig {
	notifyCopied?: (message?: string) => void
	highlightJson?: (json: string) => string
}

const AttributesConfigContext = React.createContext<AttributesConfig>({})

export function AttributesProvider({
	children,
	notifyCopied,
	highlightJson,
}: AttributesConfig & { children: React.ReactNode }) {
	const value = React.useMemo<AttributesConfig>(
		() => ({ notifyCopied, highlightJson }),
		[notifyCopied, highlightJson],
	)
	return <AttributesConfigContext value={value}>{children}</AttributesConfigContext>
}

export function useAttributesConfig(): AttributesConfig {
	return React.use(AttributesConfigContext)
}
