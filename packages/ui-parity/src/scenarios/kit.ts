import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Page } from "playwright"
import { LEGACY_BASELINE_REF, repoRoot } from "../config.ts"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * The `/lab/kit/<group>` component gallery: one isolated parity target per @maple/ui primitive.
 * Overlay items are parsed from the legacy source (like the lab registry), one scenario each.
 */
const OVERLAY_ITEMS_FILE = "apps/web/src/lab/kit/overlay-items.ts"

const overlayItemsSource = () => {
	const path = resolve(repoRoot, OVERLAY_ITEMS_FILE)
	if (existsSync(path)) return readFileSync(path, "utf8")
	return execFileSync("git", ["show", `${LEGACY_BASELINE_REF}:${OVERLAY_ITEMS_FILE}`], {
		cwd: repoRoot,
		encoding: "utf8",
	})
}

export const overlayItems = (): ReadonlyArray<string> => {
	const body = overlayItemsSource().split("OVERLAY_ITEMS = [")[1]?.split("]")[0] ?? ""
	const items = [...body.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] ?? "")
	if (items.length === 0) throw new Error(`ui-parity: no overlay items parsed from ${OVERLAY_ITEMS_FILE}`)
	return items
}

const scenario = (id: string, title: string, path: string, extra: Partial<Scenario> = {}): Scenario => ({
	id: `kit-${id}`,
	title: `Kit: ${title}`,
	path,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "kit",
	...extra,
})

const page = (group: string, extra: Partial<Scenario> = {}) =>
	scenario(group, group, `/lab/kit/${group}`, { fullPage: true, ...extra })

/** Keyboard focus on the target: focus it, Tab away and Shift+Tab back, so `:focus-visible` applies. */
const keyboardFocus = async (target: ReturnType<Page["getByRole"]>, page: Page) => {
	await target.focus()
	await page.keyboard.press("Tab")
	await page.keyboard.press("Shift+Tab")
}

/** A context menu anchors at the pointer, so it is opened by a right-click rather than `defaultOpen`. */
const OVERLAY_STEPS = new Map<string, NonNullable<Scenario["steps"]>>([
	[
		"context-menu",
		async (p) => {
			await p.getByText("Right-click a span").click({ button: "right" })
			await p.mouse.move(0, 0)
		},
	],
])

export const kitArea: AreaModule = {
	area: "kit",
	scenarios: [
		page("buttons"),
		scenario("buttons-hover", "button hover", "/lab/kit/buttons", {
			steps: async (p) => p.getByRole("button", { name: "Save changes" }).hover(),
		}),
		scenario("buttons-focus-visible", "button focus-visible", "/lab/kit/buttons", {
			steps: async (p) => keyboardFocus(p.getByRole("button", { name: "Save changes" }), p),
		}),
		page("forms"),
		scenario("forms-hover", "input hover", "/lab/kit/forms", {
			steps: async (p) => p.getByRole("textbox", { name: "Service name" }).hover(),
		}),
		scenario("forms-focus-visible", "input focus-visible", "/lab/kit/forms", {
			steps: async (p) => keyboardFocus(p.getByRole("textbox", { name: "Service name" }), p),
		}),
		page("display"),
		page("content"),
		page("navigation"),
		scenario("overlays", "overlays index", "/lab/kit/overlays"),
		...overlayItems().map((item) => {
			const steps = OVERLAY_STEPS.get(item)
			return scenario(
				`overlays-${item}`,
				`overlay ${item}`,
				`/lab/kit/overlays?item=${item}`,
				steps ? { steps } : {},
			)
		}),
	],
}
