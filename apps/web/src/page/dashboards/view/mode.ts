import * as Policy from "@maple/domain/policy"
import type { Model } from "./model"

/** The viewer's role may change this board (`dashboards:edit`). */
export const canEditDashboard = (model: Model): boolean => Policy.can(model.grants, "dashboards:edit")

/** Writes are off: a write failed, or the board is an HTTP snapshot while live sync is down. */
export const isWriteBlocked = (model: Model): boolean =>
	model.persistenceError !== null || model.snapshot._tag === "Shown"

/**
 * Edit only from the URL, for a role that may edit, never while writes are unavailable or a version
 * is previewed.
 */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" &&
	canEditDashboard(model) &&
	!isWriteBlocked(model) &&
	model.history.previewed === null
