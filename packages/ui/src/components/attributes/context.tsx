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
 *   - `renderValue` lets apps enrich specific keys (e.g. wrap a commit-SHA in a
 *     hover card) without `@maple/ui` depending on app-level components. Return
 *     null/undefined to fall back to the default copyable text. JSON values are
 *     never passed through — they always use the collapsible renderer.
 */
export interface AttributesConfig {
	notifyCopied?: (message?: string) => void
	highlightJson?: (json: string) => string
	renderValue?: (attrKey: string, value: string) => React.ReactNode | null | undefined
}

const AttributesConfigContext = React.createContext<AttributesConfig>({})

export function AttributesProvider({
	children,
	notifyCopied,
	highlightJson,
	renderValue,
}: AttributesConfig & { children: React.ReactNode }) {
	const value = React.useMemo<AttributesConfig>(
		() => ({ notifyCopied, highlightJson, renderValue }),
		[notifyCopied, highlightJson, renderValue],
	)
	return <AttributesConfigContext value={value}>{children}</AttributesConfigContext>
}

export function useAttributesConfig(): AttributesConfig {
	return React.use(AttributesConfigContext)
}
