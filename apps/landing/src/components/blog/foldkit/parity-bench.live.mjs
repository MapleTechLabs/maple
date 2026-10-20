// Moves the parity bench: screens swap per page, the camera visits each bed, the gauges read
// the run's diffs, the page lights keep score and the readout rolls to each new step.
import { lineOnTop, translateAlong } from "./iso/iso-kit.mjs"
import { BENCH } from "./parity-bench.data.mjs"
import {
	GAUGE_FULL,
	PAGES,
	RUNS,
	RUN_LENGTH,
	diffsOf,
	isIdentical,
	phaseAt,
	verdictsAfter,
} from "./parity-bench.model.mjs"

const GAUGE_KEYS = ["pixels", "structure", "calls", "a11y"]
const LIFT = 42

export function mountParityBench(stage, readout) {
	const { P, BED_CX, GAUGE_X, GAUGE_Y, GAUGE_R, GAUGE_TOP } = BENCH
	const svg = stage.querySelector("svg")
	const part = (name) => svg.querySelector(`[data-part="${name}"]`)
	const camera = part("camera")
	const carriage = part("carriage")
	const shutter = part("shutter").firstElementChild
	const frames = [part("frame-0"), part("frame-1")]
	const cones = [part("cone-0"), part("cone-1")]
	const specs = [part("spec-0"), part("spec-1")]
	const pages = specs.map((spec) => [...spec.querySelectorAll("[data-page]")])
	const button = part("button-1")
	const flow = part("flow-1")
	const lamp = part("lamp")
	const leds = PAGES.map((_, index) => part(`led-${index}`))
	const needles = GAUGE_KEYS.map((_, index) => part(`needle-${index}`))
	const still = matchMedia("(prefers-reduced-motion: reduce)")

	const needleOf = (x, share) => {
		const angle = share * Math.PI * 2
		return lineOnTop(
			[x - Math.sin(angle) * 2.6, GAUGE_Y + Math.cos(angle) * 2.6],
			[x + Math.sin(angle) * (GAUGE_R - 3.6), GAUGE_Y - Math.cos(angle) * (GAUGE_R - 3.6)],
			GAUGE_TOP + 0.2,
			P,
		)
	}
	const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)
	const easeOut = (p) => 1 - (1 - p) ** 3

	// The readout rolls word by word: each new step blurs up into place, the old one blurs out.
	const roll = document.createElement("span")
	roll.className = "pb-roll"
	if (readout) readout.replaceChildren(roll)
	let lineKey = ""
	const textOf = (word) => (typeof word === "string" ? word : word.text)
	const wordSpan = (word, index) => {
		const span = document.createElement("span")
		span.className = typeof word === "string" ? "pb-word" : `pb-word ${word.className}`
		span.style.setProperty("--i", String(index))
		span.textContent = textOf(word)
		return span
	}
	function say(key, words) {
		if (!readout) return
		const current = roll.lastElementChild
		if (key === lineKey && current) {
			// Same step: counted numbers change in place; the reserved verdict blurs in where it already sits.
			words.forEach((word, index) => {
				const span = current.children[index]
				if (span) {
					if (span.textContent !== textOf(word)) span.textContent = textOf(word)
					const className = typeof word === "string" ? "pb-word" : `pb-word ${word.className}`
					if (span.className !== className) span.className = className
					return
				}
				const added = wordSpan(word, 0)
				added.setAttribute("data-enter", "")
				current.append(" ", added)
				requestAnimationFrame(() => requestAnimationFrame(() => added.removeAttribute("data-enter")))
			})
			return
		}
		lineKey = key
		const line = document.createElement("span")
		line.className = "pb-roll__line"
		words.forEach((word, index) => {
			if (index > 0) line.append(" ")
			line.append(wordSpan(word, index))
		})
		if (current) {
			current.setAttribute("data-leave", "")
			setTimeout(() => current.remove(), 325)
		}
		line.setAttribute("data-enter", "")
		roll.append(line)
		requestAnimationFrame(() => requestAnimationFrame(() => line.removeAttribute("data-enter")))
	}
	const words = (text) => text.split(" ")

	let run = 0
	let clock = 0
	let last = 0
	let frame = 0
	let visible = false
	let drift = 0
	let shown = -1
	const dial = GAUGE_KEYS.map(() => ({ at: 0, rate: 0 }))
	const previousRun = () => RUNS[(run + RUNS.length - 1) % RUNS.length]

	function camAt(phase) {
		if (phase.name === "swap") return BED_CX[1]
		if (phase.name === "toLegacy") return BED_CX[1] + (BED_CX[0] - BED_CX[1]) * inOut(phase.progress)
		if (phase.name === "captureLegacy") return BED_CX[0]
		if (phase.name === "toFoldkit") return BED_CX[0] + (BED_CX[1] - BED_CX[0]) * inOut(phase.progress)
		return BED_CX[1]
	}

	// A new page lifts the old cards out and drops the next ones in; a re-run keeps the cards.
	function cardAt(phase, current) {
		if (phase.name !== "swap" || still.matches) return { page: current.page, lift: 0, alpha: 1 }
		const previous = previousRun()
		if (previous.page === current.page) return { page: current.page, lift: 0, alpha: 1 }
		// Cards rise first and fade only near the top, so the lift reads before they go.
		const fade = (t) => 1 - Math.min(1, Math.max(0, (t - 0.55) / 0.45))
		const p = phase.progress
		if (p < 0.48) {
			const t = inOut(p / 0.48)
			return { page: previous.page, lift: LIFT * t, alpha: fade(t) }
		}
		if (p < 0.52) return { page: current.page, lift: LIFT, alpha: 0 }
		const t = easeOut((p - 0.52) / 0.48)
		return { page: current.page, lift: LIFT * (1 - t), alpha: fade(1 - t) }
	}

	function draw(phase) {
		const current = RUNS[run]
		const name = PAGES[current.page]
		const diffs = diffsOf(current)
		const move = translateAlong(P, [camAt(phase), 0, 0])
		camera.setAttribute("transform", move)
		carriage.setAttribute("transform", move)

		const card = cardAt(phase, current)
		specs.forEach((spec) => {
			spec.setAttribute("transform", translateAlong(P, [0, 0, card.lift]))
			spec.style.opacity = card.alpha === 1 ? "" : card.alpha.toFixed(3)
		})
		if (card.page !== shown) {
			pages.forEach((list) =>
				list.forEach((el, page) => (el.style.display = page === card.page ? "" : "none")),
			)
			shown = card.page
		}

		const capturing = phase.name === "captureLegacy" ? 0 : phase.name === "captureFoldkit" ? 1 : -1
		const flash = capturing >= 0 && phase.progress > 0.15 && phase.progress < 0.75
		if (flash) shutter.setAttribute("data-lit", "")
		else shutter.removeAttribute("data-lit")
		frames.forEach((el, index) =>
			el.setAttribute("data-tone", flash && capturing === index ? "lit" : "lo"),
		)
		cones.forEach((el, index) =>
			flash && capturing === index ? el.setAttribute("data-on", "") : el.removeAttribute("data-on"),
		)
		button.setAttribute("transform", translateAlong(P, [drift, 0, 0]))
		if (current.extraCall) flow.setAttribute("data-busy", "")
		else flow.removeAttribute("data-busy")
		needles.forEach((el, index) => el.setAttribute("d", needleOf(GAUGE_X[index], dial[index].at)))

		const read = phase.name === "read" || phase.name === "hold"
		if (read && diffs.pixels > 0) button.firstElementChild.setAttribute("data-lit", "")
		else button.firstElementChild.removeAttribute("data-lit")
		const ok = isIdentical(diffs)
		lamp.setAttribute("data-state", read ? (ok ? "ok" : "fail") : "idle")
		const verdicts = read
			? verdictsAfter(run)
			: run === 0
				? PAGES.map(() => "idle")
				: verdictsAfter(run - 1)
		leds.forEach((el, index) => el.setAttribute("data-state", verdicts[index]))

		if (phase.name === "swap") {
			const rerun = previousRun().page === current.page
			say(
				`${run}-swap`,
				words(
					rerun
						? `${name} · ${current.note}`
						: `${name} · page ${current.page + 1} of ${PAGES.length}`,
				),
			)
		} else if (!read) {
			const legacy = phase.name.endsWith("Legacy")
			say(
				`${run}-${legacy ? "react" : "foldkit"}`,
				words(`${name} · capturing ${legacy ? "React" : "Foldkit"}`),
			)
		} else {
			const share = phase.name === "read" ? easeOut(phase.progress) : 1
			const n = (key) => Math.round(diffs[key] * share)
			const counts = `${n("pixels")} px · ${n("structure")} cause · ${n("calls")} calls · ${n("a11y")} a11y`
			// The verdict holds its space while the counts run, so the right-aligned line never shifts.
			const pending = phase.name === "read" ? " pb-pending" : ""
			const verdict = ok
				? { text: "passed", className: `pb-verdict pb-ok${pending}` }
				: { text: "failed", className: `pb-verdict pb-fail${pending}` }
			say(`${run}-read`, [
				...words(`${name} · ${counts}`),
				{ text: "·", className: `pb-sep${pending}` },
				verdict,
			])
		}
	}

	function step(dt) {
		const calm = still.matches
		if (!calm) clock += dt
		if (clock >= RUN_LENGTH) {
			clock -= RUN_LENGTH
			run = (run + 1) % RUNS.length
		}
		const phase = calm ? { name: "hold", progress: 1 } : phaseAt(clock)
		const current = RUNS[run]
		const diffs = diffsOf(current)
		const read = phase.name === "read" || phase.name === "hold"
		drift = calm ? current.drift : drift + (current.drift - drift) * (1 - Math.exp(-dt / 0.44))
		GAUGE_KEYS.forEach((key, index) => {
			const want = read ? Math.min(diffs[key] / GAUGE_FULL[key], 0.92) : 0
			const d = dial[index]
			if (calm) {
				d.at = want
				d.rate = 0
				return
			}
			for (let i = 0; i < 4; i++) {
				d.rate += ((want - d.at) * 102 - d.rate * 13.6) * (dt / 4)
				d.at += d.rate * (dt / 4)
			}
		})
		draw(phase)
	}

	function tick(now) {
		const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60
		last = now
		step(dt)
		frame = visible && !still.matches ? requestAnimationFrame(tick) : 0
	}
	const start = () => {
		if (!frame && visible) {
			last = 0
			frame = requestAnimationFrame(tick)
		}
	}
	const next = () => {
		run = (run + 1) % RUNS.length
		clock = 0
		if (still.matches) step(0)
		start()
	}
	new IntersectionObserver(
		(entries) => {
			visible = entries[entries.length - 1].isIntersecting
			if (visible) start()
		},
		{ rootMargin: "120px 0px" },
	).observe(stage)
	stage.addEventListener("click", next)
	stage.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return
		event.preventDefault()
		next()
	})
	step(0)
}
