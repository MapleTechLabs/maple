/**
 * Drives the live trace waterfall animation with the Web Animations API. Cycle structure:
 *
 *   PLAY  (totalMs * speed)    — bars grow in sequence at 1/speed wall-speed.
 *   PAUSE (1400ms)             — all bars full; slowest-span annotation reveals.
 *   RESET (320ms)              — frame opacity fades to 0.35 (CSS transition);
 *                                bars snap back to scaleX(0); opacity returns to 1.
 *
 * Each bar is its own `element.animate()` call with explicit delay/duration
 * matching its real wall-time window. `.is-active` is bound to each bar's
 * lifecycle (timer at start, .finished at end) so multi-active is automatic
 * and there's no per-frame index race.
 *
 * The cursor is one `element.animate()` on `transform`, so it rides the
 * compositor — no layout work per frame. Animations hold their values with
 * `fill: "both"`, so each cycle cancels the last one's before re-arming.
 */

const PAUSE_MS = 1400
const RESET_MS = 320
const DEFAULT_SPEED_DIVISOR = 10

type Row = {
	row: HTMLElement
	bar: HTMLElement
	startMs: number
	durationMs: number
}

export function startWaterfall(root: HTMLElement) {
	if (root.dataset.waterfallAttached === "1") return
	root.dataset.waterfallAttached = "1"

	const totalMs = Number(root.dataset.total ?? 200)
	const speedDivisor = Number(root.dataset.speed ?? DEFAULT_SPEED_DIVISOR)
	const stage = root.querySelector<HTMLElement>("[data-waterfall-stage]") ?? root
	const cursor = root.querySelector<HTMLElement>("[data-trace-cursor]")
	const firstTrack = root.querySelector<HTMLElement>(".span-bar-track")

	const rows: Row[] = Array.from(root.querySelectorAll<HTMLElement>(".waterfall-row")).map((row) => {
		const bar = row.querySelector<HTMLElement>(".span-bar")!
		const leftPct = parsePct(bar.style.left)
		const widthPct = parsePct(bar.style.width)
		return {
			row,
			bar,
			startMs: (leftPct / 100) * totalMs,
			durationMs: (widthPct / 100) * totalMs,
		}
	})
	if (rows.length === 0) return

	const slowestIdx = rows.reduce((best, r, i, all) => (r.durationMs > all[best].durationMs ? i : best), 0)

	let trackOffsetX = 0
	let trackWidth = 0
	const measureTrack = () => {
		if (!firstTrack) return
		const sR = stage.getBoundingClientRect()
		const tR = firstTrack.getBoundingClientRect()
		trackOffsetX = tR.left - sR.left
		trackWidth = tR.width
	}
	measureTrack()
	const ro = new ResizeObserver(measureTrack)
	ro.observe(stage)

	// Generation token: bumping it cancels any in-flight cycle. Stale callbacks
	// (timers, .finished handlers) gate on `gen === myGen` and bail otherwise.
	let gen = 0
	let inflight: Animation[] = []
	let phaseTimers: number[] = []

	const stopInflight = () => {
		inflight.forEach((a) => a.cancel())
		inflight = []
	}

	const clearPhaseTimers = () => {
		phaseTimers.forEach((t) => window.clearTimeout(t))
		phaseTimers = []
	}

	const armRows = () => {
		stopInflight()
		rows.forEach((r) => {
			r.bar.style.transform = "scaleX(0)"
			r.row.classList.remove("is-active", "is-slowest")
		})
		if (cursor) {
			cursor.style.transform = `translate3d(${trackOffsetX}px, 0, 0)`
			cursor.style.setProperty("--cursor-opacity", "0")
		}
		stage.style.setProperty("--frame-opacity", "1")
	}

	const playOnce = (myGen: number) => {
		const playSec = (totalMs * speedDivisor) / 1000

		const barAnims: Animation[] = []
		rows.forEach((r) => {
			const startSec = (r.startMs * speedDivisor) / 1000
			const durSec = Math.max(0.01, (r.durationMs * speedDivisor) / 1000)

			window.setTimeout(() => {
				if (gen === myGen) r.row.classList.add("is-active")
			}, startSec * 1000)

			const a = r.bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
				duration: durSec * 1000,
				delay: startSec * 1000,
				easing: "linear",
				fill: "both",
			})
			a.finished
				.then(() => {
					if (gen === myGen) r.row.classList.remove("is-active")
				})
				.catch(() => {})
			barAnims.push(a)
		})

		let cursorAnim: Animation | null = null
		if (cursor) {
			cursor.style.setProperty("--cursor-opacity", "1")
			cursorAnim = cursor.animate(
				[
					{ transform: `translate3d(${trackOffsetX}px, 0, 0)` },
					{ transform: `translate3d(${trackOffsetX + trackWidth}px, 0, 0)` },
				],
				{ duration: playSec * 1000, easing: "linear", fill: "both" },
			)
		}

		inflight = cursorAnim ? [...barAnims, cursorAnim] : barAnims
		return Promise.all(inflight.map((a) => a.finished)).catch(() => {})
	}

	const phaseDelay = (ms: number) =>
		new Promise<void>((resolve) => {
			const t = window.setTimeout(() => resolve(), ms)
			phaseTimers.push(t)
		})

	const cycle = async () => {
		const myGen = ++gen
		while (gen === myGen) {
			armRows()
			await playOnce(myGen)
			if (gen !== myGen) return

			rows[slowestIdx].row.classList.add("is-slowest")
			await phaseDelay(PAUSE_MS)
			if (gen !== myGen) return
			rows[slowestIdx].row.classList.remove("is-slowest")

			stage.style.setProperty("--frame-opacity", "0.35")
			if (cursor) cursor.style.setProperty("--cursor-opacity", "0")
			await phaseDelay(RESET_MS)
		}
	}

	let isVisible = false
	const io = new IntersectionObserver(
		([entry]) => {
			if (entry.isIntersecting) {
				if (!isVisible) {
					isVisible = true
					cycle()
				}
			} else if (isVisible) {
				isVisible = false
				gen++
				stopInflight()
				clearPhaseTimers()
			}
		},
		{ rootMargin: "40px" },
	)
	io.observe(root)
}

function parsePct(value: string): number {
	const n = parseFloat(value)
	return Number.isFinite(n) ? n : 0
}
