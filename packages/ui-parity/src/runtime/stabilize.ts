/**
 * Browser-side determinism, installed with `page.addInitScript` before any app code.
 * Serialized via `toString`, so it must be self-contained.
 *
 * - Math.random is seeded (generated avatars, IDs, jitter all repeat exactly)
 * - CSS animations/transitions are frozen at their end state, carets hidden
 * - scrollbars hidden (their rendering differs between headless runs)
 * - intervals run at most once per frame: a `setInterval(fn)` (0 ms) keep-alive would otherwise run
 *   back to back, starving every other timer
 * - `Date` is frozen at `now`. Only `Date`: Playwright's `page.clock` also fakes timers and
 *   requestAnimationFrame, whose callbacks then run off rendering steps and race ResizeObserver
 *   under load (lab-worst-case's virtualized waterfall settled at two scroll offsets).
 */
export const installDeterminism = (options: { readonly seed: number; readonly now: string }) => {
	let state = options.seed >>> 0
	const frozenMs = new Date(options.now).getTime()
	const RealDate = Date
	class FrozenDate extends RealDate {
		constructor(...args: ReadonlyArray<number | string | Date>) {
			const [first, monthIndex, ...rest] = args
			if (first === undefined) super(frozenMs)
			else if (monthIndex === undefined) super(first)
			else super(Number(first), Number(monthIndex), ...rest.map(Number))
		}
		static override now() {
			return frozenMs
		}
	}
	Reflect.set(window, "Date", FrozenDate)
	Math.random = () => {
		// mulberry32
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	const setIntervalOf = window.setInterval.bind(window)
	const clampedSetInterval = (handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
		setIntervalOf(handler, Math.max(Number(timeout) || 0, 16), ...args)
	Reflect.set(window, "setInterval", clampedSetInterval)

	const css = `
		*, *::before, *::after {
			animation-delay: -1ms !important;
			animation-duration: 1ms !important;
			animation-iteration-count: 1 !important;
			animation-play-state: paused !important;
			transition-duration: 0s !important;
			transition-delay: 0s !important;
			caret-color: transparent !important;
			scroll-behavior: auto !important;
		}
		::-webkit-scrollbar { display: none !important; }
		* { scrollbar-width: none !important; }
	`
	const install = () => {
		const style = document.createElement("style")
		style.setAttribute("data-parity", "stabilize")
		style.textContent = css
		document.head.appendChild(style)
	}
	if (document.head) install()
	else document.addEventListener("DOMContentLoaded", install, { once: true })
}

/**
 * Resolves once the page has visually settled: fonts loaded, images decoded, no DOM mutations for
 * `quietMs`, then two consecutive frames with no scroll or layout change. Late image loads and the
 * scroll re-anchoring they trigger restart the wait. Runs inside the page via `page.evaluate`.
 */
export const waitForVisualQuiet = async ({ quietMs, timeoutMs }: { quietMs: number; timeoutMs: number }) => {
	const deadline = performance.now() + timeoutMs
	const untilDeadline = (promise: Promise<unknown>) =>
		Promise.race([promise, new Promise((resolve) => setTimeout(resolve, deadline - performance.now()))])
	const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
	const decodeImages = () =>
		untilDeadline(Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))))
	const mutationQuiet = () =>
		new Promise<void>((resolve) => {
			let timer = setTimeout(done, quietMs)
			const observer = new MutationObserver(() => {
				clearTimeout(timer)
				if (performance.now() > deadline) return done()
				timer = setTimeout(done, quietMs)
			})
			observer.observe(document.documentElement, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true,
			})
			function done() {
				observer.disconnect()
				resolve()
			}
		})
	// Scroll offsets and extents of the window and every scrollable or overflowing element, plus image state.
	const layoutSignature = () => {
		const root = document.documentElement
		const parts: Array<number | string> = [scrollX, scrollY, root.scrollWidth, root.scrollHeight]
		for (const element of document.querySelectorAll("*")) {
			const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = element
			if (scrollTop || scrollLeft || scrollHeight > clientHeight || scrollWidth > clientWidth)
				parts.push(scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth)
		}
		for (const image of document.images) parts.push(image.complete ? image.naturalWidth : "-")
		// Charts paint on <canvas>; a canvas still animating or drawing late changes its pixels.
		for (const canvas of document.querySelectorAll("canvas")) parts.push(canvasHash(canvas))
		return parts.join(",")
	}
	// FNV-1a over the encoded pixels. WebGL canvases without preserveDrawingBuffer read back blank,
	// which is stable too, so they only count through layout.
	const canvasHash = (canvas: HTMLCanvasElement) => {
		if (!canvas.width || !canvas.height) return "0"
		let data: string
		// Serialized into the page, so no Effect runtime; toDataURL throws on a tainted canvas.
		// oxlint-disable-next-line maple/no-try-catch
		try {
			data = canvas.toDataURL()
		} catch {
			return "tainted"
		}
		let hash = 0x811c9dc5
		for (let index = 0; index < data.length; index++) {
			hash ^= data.charCodeAt(index)
			hash = Math.imul(hash, 0x01000193)
		}
		return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(36)}`
	}
	// Infinite Web Animations (`element.animate`, motion's `repeat: Infinity`) never settle. Pause each at
	// the last frame of its first iteration, the WAAPI twin of the CSS freeze above. CSS-driven ones are left
	// alone. Rate 0 also makes the screenshot's `animations: "disabled"` skip them instead of cancelling.
	const freezeInfiniteAnimations = () => {
		for (const animation of document.getAnimations()) {
			if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue
			const timing = animation.effect?.getComputedTiming()
			if (!timing || timing.endTime !== Infinity || typeof timing.duration !== "number") continue
			if (animation.playbackRate === 0) continue
			animation.pause()
			animation.currentTime = (timing.delay ?? 0) + Math.max(0, timing.duration - 0.001)
			animation.playbackRate = 0
		}
	}

	await document.fonts.ready
	for (;;) {
		await decodeImages()
		freezeInfiniteAnimations()
		await mutationQuiet()
		freezeInfiniteAnimations()
		// SMIL animations (the spin loader's <animateTransform>) ignore the CSS freeze; pin them at t=0.
		for (const svg of document.querySelectorAll("svg")) {
			svg.pauseAnimations()
			svg.setCurrentTime(0)
		}
		await decodeImages()
		// Two frames with nothing moving, so the last change is painted and nothing is still settling.
		const first = layoutSignature()
		await nextFrame()
		const second = layoutSignature()
		await nextFrame()
		if ((first === second && second === layoutSignature()) || performance.now() > deadline) return
	}
}
