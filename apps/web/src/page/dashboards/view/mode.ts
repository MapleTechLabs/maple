import type { Model } from "./model"

/** Writes are off: a write failed, or the board is an HTTP snapshot while live sync is down. */
export const isWriteBlocked = (model: Model): boolean =>
	model.persistenceError !== null || model.snapshot._tag === "Shown"

/** `mode`: edit only from the URL, never while writes are unavailable or a version is previewed. */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" && !isWriteBlocked(model) && model.history.previewed === null
