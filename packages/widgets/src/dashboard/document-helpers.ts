import type { IsoDateTimeString } from "@maple/primitives"
import { DashboardDocumentV3, type PortableDashboardDocumentV3 } from "./v3/document"

/** Fields a writer may replace on a stored dashboard; identity and timestamps are the helpers'. */
export type DashboardContentFields = Partial<Omit<PortableDashboardDocumentV3, "schemaVersion">>

/**
 * Carry a stored dashboard forward with some fields replaced.
 *
 * Spreads the decoded document rather than naming its fields, and that is the
 * whole point. The MCP tools used to rebuild the document from an explicit field
 * list, which silently dropped `sections`, `variables` and `refreshIntervalSeconds`
 * on every edit, and `sanitizeDashboardSections` then stripped the orphaned
 * `sectionId`/`tabId` off each widget, so the loss was unrecoverable. Anything
 * added to `makeDashboardDocumentFields` now survives an edit for free.
 *
 * Safe because a decoded `Schema.Class` instance carries only the keys it has:
 * an absent `Schema.optionalKey` field is not an own property, so nothing forwards
 * a present `undefined` (which the constructor rejects).
 */
export const withDocumentFields = (
	document: DashboardDocumentV3,
	fields: DashboardContentFields,
	updatedAt: IsoDateTimeString,
): DashboardDocumentV3 => new DashboardDocumentV3({ ...document, ...fields, updatedAt })

/** `withDocumentFields` for the common case: a new widget array. */
export const withWidgets = (
	document: DashboardDocumentV3,
	widgets: DashboardDocumentV3["widgets"],
	updatedAt: IsoDateTimeString,
): DashboardDocumentV3 => withDocumentFields(document, { widgets }, updatedAt)

/**
 * Replace a stored dashboard's whole content with a portable document, keeping its
 * identity. Everything the portable document carries (sections, variables, refresh)
 * comes along; what it omits is cleared, which is what a restore means.
 */
export const withPortableContent = (
	document: DashboardDocumentV3,
	portable: PortableDashboardDocumentV3,
	updatedAt: IsoDateTimeString,
): DashboardDocumentV3 =>
	new DashboardDocumentV3({
		...portable,
		id: document.id,
		createdAt: document.createdAt,
		updatedAt,
	})
