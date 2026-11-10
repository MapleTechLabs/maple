#!/usr/bin/env bun
/**
 * `bun run check:lightbox [base-url] [out-dir]`: drives the screenshot viewer in Chromium against
 * a running site with mouse, keyboard, wheel and real touch gestures (CDP). One line per check,
 * a PNG per state, a video of the desktop run; exits non-zero if a check fails.
 */
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type CDPSession, type Page } from "playwright"

const [base = "http://127.0.0.1:3391", out = "./.lightbox-check"] = process.argv.slice(2)
const DOC = "/docs/alerting/apdex-alerts"
const PLATES = ".docs-content figure.shot img"

type Check = Readonly<{ name: string; pass: boolean; detail: string }>
const checks: Array<Check> = []
const check = (name: string, pass: boolean, detail: unknown = "") => {
	const line = { name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }
	checks.push(line)
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${line.detail === "" ? "" : `  ${line.detail}`}`)
}

const read = (page: Page) =>
	page.evaluate(() => {
		const content = document.querySelector("[data-lightbox-content]")
		const track = document.querySelector("[data-lightbox-slides]")
		const zoom = document.querySelector("[data-lightbox-slide][data-active] [data-lightbox-zoom]")
		const origin = document.querySelector("[data-lightbox-origin]")
		const matrix = zoom === null ? null : new DOMMatrixReadOnly(getComputedStyle(zoom).transform)
		return {
			isOpen: content !== null,
			counter: document.querySelector("[data-lightbox-counter]")?.textContent ?? "",
			caption: document.querySelector("[data-lightbox-caption]")?.textContent ?? "",
			slide: track === null ? -1 : Math.round(track.scrollLeft / Math.max(1, track.clientWidth)),
			scale: matrix === null ? 1 : Math.round(matrix.a * 100) / 100,
			x: matrix === null ? 0 : Math.round(matrix.e),
			y: matrix === null ? 0 : Math.round(matrix.f),
			isZoomed: content?.hasAttribute("data-zoomed") ?? false,
			isFocusInside: content !== null && content.contains(document.activeElement),
			focused: document.activeElement?.getAttribute("src") ?? document.activeElement?.tagName ?? "",
			isLocked: document.body.style.overflow === "hidden",
			originSrc: origin?.getAttribute("src") ?? "",
			originOpacity: origin === null ? "" : getComputedStyle(origin).opacity,
			marks: document.querySelectorAll("[data-lightbox-trigger], [data-lightbox-origin]").length,
			hiddenSiblings: document.querySelectorAll("body > [aria-hidden='true']").length,
		}
	})

/** Waits out what the last input set in motion: a pause, then until the viewer has stopped animating. */
const settle = async (page: Page, ms = 600) => {
	await page.waitForTimeout(ms)
	await page
		.waitForFunction(
			() =>
				document.getAnimations().every((running) => {
					const effect = running.effect
					if (!(effect instanceof KeyframeEffect) || running.playState !== "running") return true
					const isTransition = (effect.pseudoElement ?? "").startsWith("::view-transition")
					return !isTransition && effect.target?.closest(".lightbox") == null
				}),
			null,
			{ timeout: 5000 },
		)
		.catch(() => {})
}

const ready = async (page: Page, path: string) => {
	await page.goto(`${base}${path}`, { waitUntil: "networkidle" })
	// The island marks the plates once it has started.
	await page.waitForSelector("img[data-zoomable][aria-haspopup]", { timeout: 20_000 })
	// Foldkit's dev plugin restores an island's Model across reloads: a run that died with the
	// viewer open would start the next one with it open too.
	if ((await page.locator("[data-lightbox-content]").count()) > 0) {
		await page.keyboard.press("Escape")
		await page.waitForSelector("[data-lightbox-content]", { state: "detached" })
	}
}

const open = async (page: Page, index: number) => {
	const plate = page.locator(PLATES).nth(index)
	await plate.scrollIntoViewIfNeeded()
	await plate.click()
	await page.waitForSelector("[data-lightbox-content]")
	await settle(page)
}

const closed = async (page: Page) => {
	await page
		.waitForSelector("[data-lightbox-content]", { state: "detached", timeout: 3000 })
		.catch(() => {})
	await settle(page, 300)
	return !(await read(page)).isOpen
}

const desktop = async (browser: Browser) => {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 2,
		recordVideo: { dir: out, size: { width: 1440, height: 900 } },
	})
	const page = await context.newPage()
	const errors: Array<string> = []
	page.on("pageerror", (error) => errors.push(error.message))

	await ready(page, DOC)
	const plates = await page.locator(PLATES).count()
	await page.locator(PLATES).nth(1).scrollIntoViewIfNeeded()
	await page.screenshot({ path: `${out}/01-docs-page.png` })

	// Open on the second shot, with animations slowed so the morph can be caught part-way.
	const animation = await context.newCDPSession(page)
	await animation.send("Animation.enable")
	await animation.send("Animation.setPlaybackRate", { playbackRate: 0.1 })
	await page.locator(PLATES).nth(1).click()
	await page.waitForTimeout(900)
	await page.screenshot({ path: `${out}/02-morph-opening.png` })
	// The group only animates when both ends exist: the plate before, the slide after.
	const morphing = await page.evaluate(() =>
		document.getAnimations().some((running) => {
			const effect = running.effect
			return (
				effect instanceof KeyframeEffect &&
				effect.pseudoElement === "::view-transition-group(lightbox-media)"
			)
		}),
	)
	check("opening morphs the plate into the viewer in a View Transition", morphing)
	await animation.send("Animation.setPlaybackRate", { playbackRate: 1 })
	await settle(page, 1200)
	await page.screenshot({ path: `${out}/03-open.png` })
	const opened = await read(page)
	check(
		"click opens the viewer on the clicked shot",
		opened.isOpen && opened.counter === `2 / ${plates}`,
		opened.counter,
	)
	check("the track sits on that slide", opened.slide === 1, opened.slide)
	check("focus moves into the dialog", opened.isFocusInside)
	check(
		"the page behind is scroll-locked and hidden from assistive tech",
		opened.isLocked && opened.hiddenSiblings > 0,
		opened.hiddenSiblings,
	)
	check(
		"the plate is hidden while its shot is in the viewer",
		opened.originOpacity === "0",
		opened.originOpacity,
	)
	check("the caption is the figure's", opened.caption.length > 0, opened.caption)

	await page.keyboard.press("/")
	await page.keyboard.down("Meta")
	await page.keyboard.press("k")
	await page.keyboard.up("Meta")
	await settle(page, 300)
	check(
		"the docs search shortcuts stand down while the viewer is open",
		(await page.locator('[role="combobox"]').count()) === 0,
	)

	await page.keyboard.press("ArrowRight")
	await settle(page, 300)
	check(
		"ArrowRight goes to the next slide",
		(await read(page)).counter === `3 / ${plates}`,
		(await read(page)).counter,
	)
	await page.getByRole("button", { name: "Previous screenshot" }).click()
	await settle(page, 300)
	check(
		"the Previous button goes back",
		(await read(page)).counter === `2 / ${plates}`,
		(await read(page)).counter,
	)
	await page.keyboard.press("Home")
	await settle(page, 300)
	const home = await read(page)
	check(
		"Home jumps to the first slide and moves the origin with it",
		home.counter === `1 / ${plates}` && home.originSrc.includes("apdex-01"),
		home.originSrc,
	)

	// Zoom: keys, buttons, mouse, ctrl + wheel.
	await page.keyboard.press("ArrowRight")
	await settle(page, 300)
	await page.keyboard.press("+")
	await settle(page)
	await page.screenshot({ path: `${out}/04-zoomed.png` })
	const zoomed = await read(page)
	check("+ zooms in one step", zoomed.scale === 2 && zoomed.isZoomed, zoomed.scale)
	await page.keyboard.press("ArrowRight")
	await settle(page, 300)
	const panned = await read(page)
	check(
		"arrows pan a zoomed shot instead of turning the page",
		panned.counter === `2 / ${plates}` && panned.x < zoomed.x,
		{ from: zoomed.x, to: panned.x },
	)
	await page.keyboard.press("0")
	await settle(page)
	check("0 returns to rest", (await read(page)).scale === 1 && !(await read(page)).isZoomed)

	await page.mouse.click(1000, 300)
	await settle(page)
	const clicked = await read(page)
	check("a click on the shot zooms toward the pointer", clicked.scale === 2 && clicked.x < 0, clicked)
	await page.mouse.move(700, 450)
	await page.mouse.down()
	await page.mouse.move(820, 520, { steps: 6 })
	await page.mouse.up()
	await settle(page)
	const dragged = await read(page)
	check("dragging pans the zoomed shot", dragged.scale === 2 && dragged.x > clicked.x, {
		from: clicked.x,
		to: dragged.x,
	})
	await page.mouse.click(700, 450)
	await settle(page)
	check("a second click zooms back out", (await read(page)).scale === 1)

	await page.mouse.move(900, 400)
	await page.keyboard.down("Control")
	await page.mouse.wheel(0, -120)
	await page.keyboard.up("Control")
	await settle(page, 300)
	const wheeled = await read(page)
	check("ctrl + wheel zooms at the pointer", wheeled.scale > 1, wheeled.scale)
	await page.keyboard.press("0")
	await settle(page)

	// Ways out.
	// One run of wheel events, as a trackpad or a spun wheel sends them. Chromium scales the
	// delta by the device pixel ratio, so each of these arrives as half.
	const pointer = await context.newCDPSession(page)
	for (const _ of Array.from({ length: 4 })) {
		await pointer.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: 900,
			y: 400,
			deltaX: 0,
			deltaY: 100,
		})
	}
	check("wheeling the shot away dismisses", await closed(page))

	await open(page, 0)
	await page.keyboard.press("End")
	await settle(page, 300)
	await page.screenshot({ path: `${out}/05-last-slide.png` })
	await animation.send("Animation.setPlaybackRate", { playbackRate: 0.1 })
	await page.keyboard.press("Escape")
	await page.waitForTimeout(1200)
	await page.screenshot({ path: `${out}/06-morph-closing.png` })
	await animation.send("Animation.setPlaybackRate", { playbackRate: 1 })
	const escaped = await closed(page)
	const after = await read(page)
	await page.screenshot({ path: `${out}/07-closed-on-last-plate.png` })
	check("Escape closes", escaped)
	const last = await page
		.locator(PLATES)
		.nth(plates - 1)
		.boundingBox()
	check(
		"closing lands on the plate of the slide that was open",
		last !== null && last.y + last.height > 0 && last.y < 900,
		last,
	)
	check("focus returns to that plate", after.focused.includes("apdex-04"), after.focused)
	check("the page is released", !after.isLocked && after.hiddenSiblings === 0)
	await settle(page, 900)
	check("the plates lose their marks once closed", (await read(page)).marks === 0, (await read(page)).marks)

	await open(page, 0)
	await page.mouse.click(24, 200)
	check("a click beside the shot closes", await closed(page))

	await open(page, 0)
	await page.mouse.move(700, 400)
	await page.mouse.down()
	await page.mouse.move(705, 560, { steps: 8 })
	await page.mouse.up()
	check("dragging the shot away with the mouse dismisses", await closed(page))

	await open(page, 0)
	for (const _ of Array.from({ length: 7 })) await page.keyboard.press("Tab")
	check("Tab stays inside the viewer", (await read(page)).isFocusInside)
	await page.getByRole("button", { name: "Close" }).click()
	check("the Close button closes", await closed(page))

	await page.locator(PLATES).nth(2).focus()
	await page.keyboard.press("Enter")
	await page.waitForSelector("[data-lightbox-content]")
	await settle(page)
	check("Enter on a focused plate opens it", (await read(page)).counter === `3 / ${plates}`)
	await page.keyboard.press("Escape")
	await closed(page)

	// A marketing plate on its own: no gallery, no counter.
	await ready(page, "/")
	const hero = page.locator("img[data-zoomable]").first()
	await hero.scrollIntoViewIfNeeded()
	await hero.click()
	await page.waitForSelector("[data-lightbox-content]")
	await settle(page)
	await page.screenshot({ path: `${out}/08-home-plate.png` })
	const solo = await read(page)
	check("a plate outside an article opens alone", solo.isOpen && solo.counter === "", solo.counter)
	check(
		"and has no step buttons",
		(await page.getByRole("button", { name: "Next screenshot" }).count()) === 0,
	)
	await page.keyboard.press("Escape")
	check("and closes", await closed(page))

	check("no page errors", errors.length === 0, errors)
	await context.close()
}

const touch = async (
	session: CDPSession,
	type: "touchStart" | "touchMove" | "touchEnd",
	x?: number,
	y?: number,
) =>
	session.send("Input.dispatchTouchEvent", {
		type,
		touchPoints: x === undefined || y === undefined ? [] : [{ x, y, id: 1 }],
	})

const drag = async (
	page: Page,
	session: CDPSession,
	from: readonly [number, number],
	dy: number,
	release = true,
) => {
	await touch(session, "touchStart", from[0], from[1])
	for (const step of Array.from({ length: 10 }, (_, index) => index + 1)) {
		await touch(session, "touchMove", from[0], from[1] + (dy * step) / 10)
		await page.waitForTimeout(24)
	}
	if (release) await touch(session, "touchEnd")
}

const phone = async (browser: Browser) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 3,
		hasTouch: true,
		isMobile: true,
	})
	const page = await context.newPage()
	const session = await context.newCDPSession(page)
	await ready(page, DOC)
	const plates = await page.locator(PLATES).count()
	const first = page.locator(PLATES).first()
	await first.scrollIntoViewIfNeeded()
	await first.tap()
	await page.waitForSelector("[data-lightbox-content]")
	await settle(page)
	await page.screenshot({ path: `${out}/09-phone-open.png` })
	check("phone: a tap opens the viewer", (await read(page)).counter === `1 / ${plates}`)

	await session.send("Input.synthesizeScrollGesture", {
		x: 300,
		y: 420,
		xDistance: -260,
		speed: 1400,
		gestureSourceType: "touch",
	})
	await settle(page, 900)
	const swiped = await read(page)
	check(
		"phone: a swipe turns to the next slide",
		swiped.counter === `2 / ${plates}` && swiped.slide === 1,
		swiped.counter,
	)

	await session.send("Input.synthesizePinchGesture", {
		x: 195,
		y: 420,
		scaleFactor: 2.2,
		relativeSpeed: 600,
		gestureSourceType: "touch",
	})
	await settle(page, 900)
	const pinched = await read(page)
	await page.screenshot({ path: `${out}/10-phone-pinched.png` })
	check(
		"phone: a pinch zooms the shot, not the page",
		pinched.scale > 1.2 && pinched.isZoomed,
		pinched.scale,
	)
	check(
		"phone: the page itself did not zoom",
		(await page.evaluate(() => visualViewport?.scale ?? 1)) === 1,
	)

	await page.touchscreen.tap(195, 420)
	await page.waitForTimeout(90)
	await page.touchscreen.tap(195, 420)
	await settle(page)
	check("phone: a double tap zooms back out", (await read(page)).scale === 1, (await read(page)).scale)
	await page.touchscreen.tap(195, 420)
	await page.waitForTimeout(90)
	await page.touchscreen.tap(195, 420)
	await settle(page)
	const anchored = await read(page)
	check(
		"phone: after a swipe, a double tap zooms about the point that was tapped",
		anchored.scale === 2 && Math.abs(anchored.x) <= 2,
		{ scale: anchored.scale, x: anchored.x },
	)
	await page.touchscreen.tap(195, 420)
	await page.waitForTimeout(90)
	await page.touchscreen.tap(195, 420)
	await settle(page)
	await page.touchscreen.tap(195, 420)
	await settle(page, 500)
	check("phone: a single tap does not zoom", (await read(page)).scale === 1)

	await drag(page, session, [195, 420], 48)
	await settle(page)
	const snapped = await read(page)
	check("phone: a short pull snaps back", snapped.isOpen && snapped.y === 0, snapped.y)

	await drag(page, session, [195, 420], 180, false)
	await page.screenshot({ path: `${out}/11-phone-pulling.png` })
	const pulling = await read(page)
	check("phone: a pull drags the shot and thins the backdrop", pulling.y > 60 && pulling.scale < 1, {
		y: pulling.y,
		scale: pulling.scale,
	})
	await touch(session, "touchEnd")
	check("phone: letting go past the threshold dismisses", await closed(page))
	await context.close()
}

const calm = async (browser: Browser) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		reducedMotion: "reduce",
	})
	const page = await context.newPage()
	await ready(page, DOC)
	await open(page, 0)
	check("reduced motion: opens without the morph", (await read(page)).isOpen)
	await page.keyboard.press("+")
	await page.waitForTimeout(80)
	check("reduced motion: zoom lands at once", (await read(page)).scale === 2, (await read(page)).scale)
	await page.keyboard.press("Escape")
	check("reduced motion: closes", await closed(page))

	// A narrow window hides the step buttons: Tab must still cycle inside the viewer.
	await page.setViewportSize({ width: 700, height: 800 })
	await open(page, 0)
	for (const _ of Array.from({ length: 5 })) await page.keyboard.press("Shift+Tab")
	check(
		"narrow: Shift+Tab stays inside the viewer",
		(await read(page)).isFocusInside,
		(await read(page)).focused,
	)
	await page.keyboard.press("Escape")
	await closed(page)
	await context.close()
}

await mkdir(out, { recursive: true })
const browser = await chromium.launch()
await desktop(browser)
await phone(browser)
await calm(browser)
await browser.close()

const failed = checks.filter((entry) => !entry.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
