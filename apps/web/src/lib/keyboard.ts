const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

/** True when the event target is a text field / contentEditable — skip shortcuts there. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	if (EDITABLE_TAGS.has(target.tagName)) return true
	if (target.isContentEditable) return true
	return false
}

/** True when a modal dialog is open — skip page-level shortcuts so the dialog owns the keyboard. */
export function isDialogOpen(): boolean {
	return document.querySelector('[role="dialog"][data-state="open"]') !== null
}
