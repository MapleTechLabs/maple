import type { IssueKind } from "@maple/domain/http"

/** What opened an issue. */
export const SOURCES: ReadonlyArray<IssueKind> = ["error", "alert", "integration"]

export const SOURCE_COLOR = {
	error: "var(--chart-error)",
	alert: "var(--color-violet-500)",
	integration: "var(--color-teal-500)",
} satisfies Record<IssueKind, string>

export const SOURCE_DESCRIPTION = {
	error: "Fingerprinted errors from spans. Nearly every row.",
	alert: "Opened by an alert rule, one per rule and group, named after the rule.",
	integration: "Raised by a connected system, such as a PlanetScale event.",
} satisfies Record<IssueKind, string>
