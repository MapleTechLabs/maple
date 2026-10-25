import type { Model } from "./model"

/** `mode`: edit only from the URL, never while writes are unavailable or a version is previewed. */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" && model.persistenceError === null && model.history.previewed === null
