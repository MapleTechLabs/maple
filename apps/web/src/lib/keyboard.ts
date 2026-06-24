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
	// Base UI marks open popups with a bare `data-open` attribute (not Radix's `data-state="open"`).
	return document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null
}

/**
 * True when ANY keyboard-owning overlay is open — a dialog, a dropdown menu, or
 * a listbox (select / combobox). Page-level capture-phase shortcuts (arrow-key
 * pan/zoom, the "F" expand key) must defer to these so the overlay's own
 * arrow/typeahead navigation keeps working. Broader than `isDialogOpen` because
 * Base UI menus render as `role="menu"` and selects/comboboxes as
 * `role="listbox"`, neither of which is a dialog.
 */
export function isOverlayOpen(): boolean {
	return (
		document.querySelector(
			'[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open], [role="listbox"][data-open]',
		) !== null
	)
}
