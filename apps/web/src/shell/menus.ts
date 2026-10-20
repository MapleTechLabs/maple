import type { Align, Side } from "../ui/anchor"
import { Menu } from "./message"

/** Trigger element id: the positioning Mount anchors to it and focus returns to it on Escape. */
export const triggerIdOf = (menu: Menu): string =>
	Menu.match(menu, {
		Org: () => "shell-org-switcher",
		User: () => "shell-user-menu",
		Support: () => "shell-support-menu",
		NavSection: ({ title }) => `shell-nav-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
	})

export const popupIdOf = (menu: Menu): string => `${triggerIdOf(menu)}-popup`

/** Each menu's popup placement. */
export const placementOf = (
	menu: Menu,
): Readonly<{ side: Side; align: Align; sideOffset: number; className: string | undefined }> =>
	Menu.match(menu, {
		Org: () => ({ side: "right", align: "start", sideOffset: 4, className: "min-w-56" }) as const,
		User: () => ({ side: "top", align: "start", sideOffset: 4, className: "min-w-56" }) as const,
		Support: () => ({ side: "top", align: "end", sideOffset: 4, className: undefined }) as const,
		NavSection: () => ({ side: "right", align: "start", sideOffset: 4, className: "min-w-44" }) as const,
	})

export const isSameMenu = (a: Menu, b: Menu): boolean => triggerIdOf(a) === triggerIdOf(b)
