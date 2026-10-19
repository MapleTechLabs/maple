import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { KitPage, KitSection } from "./kit-layout"
import { OVERLAY_ITEMS, type OverlayItem } from "./overlay-items"
import { KitAlertDialog, KitDialog, KitHoverCard, KitPopover, KitSheet, KitTooltip } from "./overlays-dialogs"
import { KitCommand, KitContextMenu, KitDropdownMenu, KitToast } from "./overlays-menus"
import { KitAutocomplete, KitComboboxChips, KitSelect } from "./pickers"

const RENDER = {
	dialog: () => <KitDialog />,
	"alert-dialog": () => <KitAlertDialog />,
	sheet: () => <KitSheet />,
	popover: () => <KitPopover />,
	tooltip: () => <KitTooltip />,
	"hover-card": () => <KitHoverCard />,
	"dropdown-menu": () => <KitDropdownMenu />,
	"context-menu": () => <KitContextMenu />,
	select: () => <KitSelect open />,
	combobox: () => <KitComboboxChips open />,
	autocomplete: () => <KitAutocomplete open />,
	command: () => <KitCommand />,
	"toast-default": () => <KitToast type="default" />,
	"toast-success": () => <KitToast type="success" />,
	"toast-error": () => <KitToast type="error" />,
	"toast-info": () => <KitToast type="info" />,
	"toast-warning": () => <KitToast type="warning" />,
	"toast-loading": () => <KitToast type="loading" />,
} satisfies Record<OverlayItem, () => ReactNode>

const isOverlayItem = (value: string | undefined): value is OverlayItem =>
	OVERLAY_ITEMS.some((name) => name === value)

// Overlays cannot share a page without overlapping, so `?item=` picks the one rendered open.
export function KitOverlaysLab({ item: rawItem }: { item: string | undefined }) {
	const item = isOverlayItem(rawItem) ? rawItem : undefined
	return (
		<KitPage
			title="Kit: overlays"
			description="One overlay from @maple/ui per ?item=, rendered open on mount."
		>
			<KitSection title="Items">
				<nav aria-label="Overlay items" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
					{OVERLAY_ITEMS.map((name) => (
						<Link
							key={name}
							to="/lab/kit/overlays"
							search={{ item: name }}
							className={
								name === item
									? "font-medium text-foreground"
									: "text-muted-foreground hover:text-foreground"
							}
						>
							{name}
						</Link>
					))}
				</nav>
			</KitSection>
			{item !== undefined ? (
				<KitSection title={item}>
					<div className="flex min-h-48 items-start">{RENDER[item]()}</div>
				</KitSection>
			) : null}
		</KitPage>
	)
}
