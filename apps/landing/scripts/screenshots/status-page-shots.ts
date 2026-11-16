/**
 * The status pages feature's plates, as data: rendered by `status-pages.ts` from the real
 * public-page renderer rather than captured from the stack like `shots.ts`.
 */
import type { StatusPageThemePreset } from "@maple/domain/status-page"

export interface StatusPageShot {
	readonly id: string
	readonly preset: StatusPageThemePreset
	readonly appearance: "light" | "dark"
	readonly font: "sans" | "mono" | "serif"
	/** CSS viewport; the output is this times `scale`. */
	readonly viewport: { readonly width: number; readonly height: number }
	readonly scale: number
	/** Scroll this element to the top before the shot; the page top when unset. */
	readonly from?: string
}

export const STATUS_PAGE_SHOTS: ReadonlyArray<StatusPageShot> = [
	// Panel plate: Maple's own theme, the page a visitor lands on mid-incident.
	{
		id: "status-page-panel",
		preset: "maple",
		appearance: "dark",
		font: "mono",
		viewport: { width: 880, height: 840 },
		scale: 3,
	},
	// Gallery, at GALLERY_SHOT_SIZE (2880 x 1620): the 90-day bars, then the page in another theme.
	{
		id: "gallery-status-page-uptime",
		preset: "default",
		appearance: "dark",
		font: "sans",
		viewport: { width: 960, height: 540 },
		scale: 3,
		from: "#h-components",
	},
	{
		id: "gallery-status-page-paper",
		preset: "paper",
		appearance: "light",
		font: "serif",
		viewport: { width: 960, height: 540 },
		scale: 3,
	},
]
