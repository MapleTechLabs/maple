import { expect, test, type Page } from "@playwright/test"

// The dashboard grid under the three things it does: mount a board, carry a
// tile across it, and resize a tile. `/lab/bench/dashboard-grid` renders a
// 50-widget board in edit mode whose tiles each draw ~150 elements, so a grid
// that re-renders tile content while dragging pays for it here.
//
// Gates are structural (React commits, content renders, layout shift), not
// wall-clock: those do not move with runner speed. Timings are logged; the
// react-grid-layout baseline the grid replaced is recorded in
// docs/benchmarks/dashboard-grid-2026-10-08.json (182 commits for this drag).

interface ReactRenderMetrics {
	commits: number
	totalActualDurationMs: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
}

interface InteractionMetrics {
	frames: number
	frameP95Ms: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	react: ReactRenderMetrics
}

interface MountMetrics {
	mountMs: number
	layoutShift: number
	commits: number
}

declare global {
	interface Window {
		__dashboardGridBench?: {
			ready: boolean
			beginInteraction: () => void
			endInteraction: () => Promise<InteractionMetrics>
			measureMount: () => Promise<MountMetrics>
			contentRenders: () => number
			layoutCommits: () => number
			lastCommitSize: () => number
		}
	}
}

const WIDGETS = Number(process.env.DASHBOARD_GRID_WIDGETS ?? 50)

async function open(page: Page) {
	await page.goto(`/lab/bench/dashboard-grid?n=${WIDGETS}`)
	await page.waitForFunction(() => window.__dashboardGridBench?.ready === true, undefined, {
		timeout: 30_000,
	})
}

interface SweepResult {
	metrics: InteractionMetrics
	/** Tile content renders while the pointer was down. */
	contentRendersDuring: number
	/** ... and in total, including the drop's commit. */
	contentRenders: number
	layoutCommits: number
	changedWidgets: number
}

/** Press on `selector`, move by (dx, dy) in `steps` pointer events, release. */
/**
 * The long-task COUNT is environmental on GitHub's GPU-less runners, so CI
 * gates on blocking time and local runs on the stricter zero-long-task rule.
 * Same split as infra.perf.spec.ts.
 */
function expectNoJank(metrics: InteractionMetrics, label: string) {
	if (process.env.CI) expect(metrics.totalBlockingMs, `${label} blocking ms (CI ceiling)`).toBeLessThan(200)
	else expect(metrics.longTasks, `${label} long tasks`).toBe(0)
}

async function sweep(
	page: Page,
	selector: string,
	dx: number,
	dy: number,
	steps: number,
): Promise<SweepResult> {
	const handle = page.locator(selector).first()
	await handle.scrollIntoViewIfNeeded()
	const box = await handle.boundingBox()
	if (!box) throw new Error(`no box for ${selector}`)
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	await page.mouse.move(x, y)
	await page.evaluate(() => window.__dashboardGridBench!.beginInteraction())
	await page.mouse.down()
	await page.mouse.move(x + dx, y + dy, { steps })
	const contentRendersDuring = await page.evaluate(() => window.__dashboardGridBench!.contentRenders())
	await page.mouse.up()
	// The drop's store update is a transition, rendered in slices after the
	// release; wait it out so the totals include it.
	await page.waitForTimeout(600)
	const metrics = await page.evaluate(() => window.__dashboardGridBench!.endInteraction())
	const { contentRenders, layoutCommits, changedWidgets } = await page.evaluate(() => ({
		contentRenders: window.__dashboardGridBench!.contentRenders(),
		layoutCommits: window.__dashboardGridBench!.layoutCommits(),
		changedWidgets: window.__dashboardGridBench!.lastCommitSize(),
	}))
	return { metrics, contentRendersDuring, contentRenders, layoutCommits, changedWidgets }
}

test(`mounting a ${WIDGETS}-widget board does not shift`, async ({ page }) => {
	await open(page)
	const runs: MountMetrics[] = []
	for (let run = 0; run < 5; run++)
		runs.push(await page.evaluate(() => window.__dashboardGridBench!.measureMount()))
	const mountMs = runs.map((run) => run.mountMs).sort((a, b) => a - b)
	console.log("[perf] dashboard-grid mount:", JSON.stringify({ medianMs: mountMs[2], runs }))
	for (const run of runs) {
		expect(run.layoutShift, "mount layout shift").toBe(0)
		// Placement is CSS Grid, so there is no measure-then-place second pass.
		expect(run.commits, "React commits to mount").toBe(1)
	}
})

test("dragging a tile across the board re-renders no tile content until the drop", async ({ page }) => {
	await open(page)
	// A stat in the top row, carried down and across two thirds of the board.
	const result = await sweep(page, "[data-bench-tile='stat-0'] .widget-drag-handle", 700, 500, 180)
	console.log("[perf] dashboard-grid drag:", JSON.stringify(result))
	expect(result.layoutCommits, "one drop, one commit").toBe(1)
	expect(result.contentRendersDuring, "tile content renders while dragging").toBe(0)
	// The drop's commit hands the moved widgets new objects, so those, and only
	// those, re-render once (twice under the dev server's StrictMode)...
	expect(result.contentRenders, "tile content renders at drop").toBeLessThanOrEqual(
		result.changedWidgets * 2,
	)
	// ...in time slices, not one blocking commit.
	expectNoJank(result.metrics, "drag and drop")
	// One commit per cell crossed that changed the layout, plus pick-up and
	// drop: 180 pointer events must not mean 180 renders.
	expect(result.metrics.react.commits, "React commits for a 180-event drag").toBeLessThanOrEqual(30)
})

test("resizing a tile re-renders no tile content until release", async ({ page }) => {
	await open(page)
	const result = await sweep(
		page,
		"[data-grid-item]:has([data-bench-tile='stat-4']) > [data-grid-resize-handle]",
		300,
		260,
		120,
	)
	console.log("[perf] dashboard-grid resize:", JSON.stringify(result))
	expect(result.layoutCommits, "one release, one commit").toBe(1)
	expect(result.contentRendersDuring, "tile content renders while resizing").toBe(0)
	expect(result.contentRenders, "tile content renders at release").toBeLessThanOrEqual(
		result.changedWidgets * 2,
	)
	expectNoJank(result.metrics, "resize and release")
	expect(result.metrics.react.commits, "React commits for a 120-event resize").toBeLessThanOrEqual(20)
})
