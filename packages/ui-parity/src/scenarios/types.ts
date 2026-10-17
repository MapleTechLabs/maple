import type { Locator, Page } from "playwright"
import type { TargetName } from "../config.ts"
import type { Faults } from "../contract.ts"

/**
 * A scenario is one screen state, captured identically in every target.
 *
 * Steps drive the page with accessible locators (`getByRole`, `getByText`), never CSS selectors
 * or test ids, so the same script runs against the React app and the Foldkit app. If a step cannot
 * find its element in one app, that is itself a parity failure (wrong role, missing label).
 */
export interface Scenario {
	readonly id: string
	readonly title: string
	readonly path: string
	/**
	 * Fixture dataset served for this scenario (`FixtureBackend.datasets`). Omitted: no dataset,
	 * signed out, clock frozen at `NO_DATASET_NOW`, for screens that render from fixtures (`/lab`).
	 */
	readonly dataset?: string
	readonly viewports?: ReadonlyArray<ViewportName>
	readonly themes?: ReadonlyArray<ThemeName>
	readonly steps?: (page: Page) => Promise<void>
	/** Elements whose pixels are excluded from the diff (e.g. a live clock). Accessible locators only. */
	readonly mask?: (page: Page) => ReadonlyArray<Locator>
	/**
	 * Call-log tag prefixes the page inside a shell scenario sends (`warehouse:`, `shape:alert_`),
	 * left out of the behavior diff while the page is a placeholder. Shell calls still count.
	 */
	readonly pageCalls?: ReadonlyArray<string>
	/**
	 * Targets the screen exists in (default: all). A run or selfcheck skips the scenario unless every
	 * build it captures is one of these, e.g. `["foldkit"]` for a Foldkit-only lab probe.
	 */
	readonly targets?: ReadonlyArray<TargetName>
	/** Delays and failures on top of the dataset's (`contract.ts`), e.g. a held or failing execute-batch. */
	readonly faults?: Faults
	/**
	 * `"quiet"` (default): visual quiet after every settle point. `"held"`: first wait until every
	 * API request still in flight is one `faults.delays` holds, to capture a loading state.
	 */
	readonly settle?: "quiet" | "held"
	/** Default true: the whole page, including inner scrollers grown to their content. */
	readonly fullPage?: boolean
	/** Tag for grouping in the report and for `--filter`. */
	readonly area: string
}

/** Frozen wall clock for scenarios without a dataset. */
export const NO_DATASET_NOW = "2026-10-01T12:00:00.000Z"

export const viewports = {
	desktop: { width: 1440, height: 900 },
	laptop: { width: 1280, height: 800 },
	mobile: { width: 390, height: 844 },
} as const
export type ViewportName = keyof typeof viewports

export type ThemeName = "light" | "dark"

/**
 * One file per area (`src/scenarios/<area>.ts`), aggregated by `src/scenarios.ts`, so parallel
 * work on different areas never edits the same file. Datasets belong to the fixture backend.
 */
export interface AreaModule {
	readonly area: string
	readonly scenarios: ReadonlyArray<Scenario>
}
