import type { Model } from "./model"

/** `mode`: edit only from the URL, and never while writes are unavailable. */
export const isEditing = (model: Model): boolean =>
	model.search.mode === "edit" && model.persistenceError === null
