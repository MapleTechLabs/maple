import * as Policy from "@maple/domain/policy"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { lockedControl } from "@maple/views/ui/locked-control"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { button, linkButton } from "@maple/views/ui/button"
import { denialReason, gatedControl } from "./session-grants"

// Controls behind a permission, drawn disabled with who can use them for a viewer without it: menu
// items, switches, link buttons, and any control when the view only has the verdict.

type Grants = Readonly<{ grants: ReadonlyArray<Policy.Permission> }>

const hasGrant = (model: Grants, permission: Policy.Permission): boolean =>
	Policy.has(model.grants, permission)

/**
 * A row menu's entries for a viewer without `permission`: every item disabled, the denial as its
 * tooltip, except the `readOnly` values (Open, View), which need no permission.
 */
export const gatedEntries = (
	model: Grants,
	permission: Policy.Permission,
	entries: ReadonlyArray<MenuEntry>,
	readOnly: ReadonlyArray<string> = [],
): ReadonlyArray<MenuEntry> => {
	if (hasGrant(model, permission)) return entries
	const reason = denialReason(permission)
	return Arr.map(entries, (entry): MenuEntry =>
		entry._tag === "Item" && !readOnly.includes(entry.value)
			? { ...entry, isDisabled: true, tooltip: { content: [reason] } }
			: entry,
	)
}

/**
 * A `switchControl`'s parts for a viewer without `permission`: the track, drawn disabled by the
 * caller, carries the denial; the hidden input stays outside the hover target.
 */
export const gatedSwitch = <Message>(
	h: HtmlBuilder<Message>,
	model: Grants,
	permission: Policy.Permission,
	parts: ReadonlyArray<Html>,
): ReadonlyArray<Html> =>
	hasGrant(model, permission)
		? parts
		: Arr.map(parts, (part, index) =>
				index === 0 ? lockedControl(h, denialReason(permission), part) : part,
			)

/** A link button behind `permission`; locked, it is a disabled button, since an anchor cannot be disabled. */
export const gatedLinkButton = <Message>(
	h: HtmlBuilder<Message>,
	model: Grants,
	permission: Policy.Permission,
	options: Readonly<{ href: string; size?: "sm"; variant?: "outline" | "ghost" }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	gatedControl(h, model, permission, (isDisabled) =>
		isDisabled
			? button(h, { size: options.size, variant: options.variant, isDisabled }, children)
			: linkButton(h, options, children),
	)

/** `gatedControl` for a view that only has the verdict: `isAllowed` draws it enabled, else locked with the denial. */
export const gatedBy = <Message>(
	h: HtmlBuilder<Message>,
	isAllowed: boolean,
	permission: Policy.Permission,
	control: (isLocked: boolean) => Html,
	options: Readonly<{ className?: string }> = {},
): Html => (isAllowed ? control(false) : lockedControl(h, denialReason(permission), control(true), options))
