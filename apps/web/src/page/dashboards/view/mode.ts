import { canEditDashboards } from "../kit/grants"
import type { Model } from "./model"

/** Writes are off: a write failed, or the board is an HTTP snapshot while live sync is down. */
export const isWriteBlocked = (model: Model): boolean =>
	model.persistenceError !== null || model.snapshot._tag === "Shown"

/**
 * Edit only from the URL, never while writes are unavailable or a version is previewed. A viewer
 * without `dashboards:edit` who opens `?mode=edit` gets the read view.
 */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" &&
	canEditDashboards(model) &&
	!isWriteBlocked(model) &&
	model.history.previewed === null
