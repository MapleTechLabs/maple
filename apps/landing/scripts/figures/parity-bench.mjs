// Builds the parity bench figure: a comparator bench that photographs the React build and the
// Foldkit build fed from one fixture tank, and reads the four diffs on dial gauges.
// Writes src/components/blog/foldkit/parity-bench.data.mjs and a standalone page for checks.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as k from "../../src/components/blog/foldkit/iso/iso-kit.mjs"
import { BUTTON } from "../../src/components/blog/foldkit/parity-bench.model.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIG_DIR = join(HERE, "../../src/components/blog/foldkit")
const OUT = process.env.PARITY_BENCH_OUT ?? "/tmp/parity-bench"
const theme = process.argv.includes("--light") ? "light" : "dark"

const WIDTH = 640
const HEIGHT = 360

const PLATE = { x: -168, y: -88, w: 336, d: 182, r: 9 }
const PLATE_H = 10
const FOOT_H = 5

const BED_CX = [-70, 70]
const BED_CY = 0
const bedPlan = (cx) => ({ x: cx - 52, y: BED_CY - 34, w: 104, d: 68, r: 4 })
const BED_H = 5
const specPlan = (cx) => ({ x: cx - 44, y: BED_CY - 28, w: 88, d: 56, r: 3 })
const SPEC_Z = BED_H
const SPEC_H = 4
const SPEC_TOP = SPEC_Z + SPEC_H
const screenPlan = (cx) => k.insetPlan(specPlan(cx), 3)
const BUTTON_Z = SPEC_TOP
const BUTTON_H = 1.4
const buttonPlan = (cx) => {
	const s = screenPlan(cx)
	return { x: s.x + s.w - 24, y: s.y + 2, w: BUTTON.w, d: BUTTON.d, r: 1 }
}

const TANK = [0, -64]
const TANK_R = 15
const TANK_TOP = 56
const MANIFOLD = { x: -15, y: -44, w: 30, d: 14, r: 2 }
const MANIFOLD_H = 12
const DUCT_Y = -39
const DUCT_D = 5
const DUCT_H = 5
const inletPlan = (cx) => ({ x: cx - 7, y: bedPlan(cx).y - 9, w: 14, d: 9, r: 1.5 })

const WATCH = [-134, -58]
const WATCH_R = 12

const POST_X = [-152, 152]
const BEAM_Y = BED_CY
const BEAM = { x: -160, y: BEAM_Y - 5, w: 320, d: 10, r: 2 }
const BEAM_Z = 62
const BEAM_H = 8
const CAM = { x: -9, y: BEAM_Y - 7, w: 18, d: 14, r: 2.5 }
const CAM_Z = 44
const CAM_TOP = 58
const LENS_R = 6
const LENS_Z = 36

const CONSOLE = { x: -152, y: 52, w: 304, d: 30, r: 4 }
const CONSOLE_H = 10
const GAUGE_X = [-112, -64, -16, 32]
const GAUGE_Y = 67
const GAUGE_R = 12
const GAUGE_Z = CONSOLE_H
const GAUGE_H = 7
const GAUGE_TOP = GAUGE_Z + GAUGE_H
const LAMP = [82, 67]

const STRIP = { x: -150, y: 85, w: 300, d: 6, r: 1 }

const P = k.fitProjection(
	[
		...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
		[POST_X[0], BEAM_Y, BEAM_Z + BEAM_H + 6],
		[POST_X[1], BEAM_Y, BEAM_Z + BEAM_H + 6],
		[TANK[0], TANK[1], TANK_TOP + 10],
	],
	WIDTH,
	HEIGHT,
	{ pad: 34, azimuth: 63 },
)

const at = (point) => k.iso(point, P)
const S = (paths, style) => k.solidSvg(paths, style)
const L = (d, style) => k.lineSvg(d, style)
const D = (points, style) => k.dotsSvg(points, style)
const byDepth = (points) =>
	[...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P))
const halo = (plan, z, h, blur = 9) =>
	`<path class="iso-halo" d="${k.haloOf(plan, z, h, P)}"${blur === 9 ? "" : ` style="filter:blur(${blur}px)"`}/>`

function plate() {
	const out = [halo(PLATE, -PLATE_H - FOOT_H, PLATE_H)]
	for (const [x, y] of byDepth(k.corners(PLATE, 24))) {
		out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }))
		out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }))
	}
	out.push(
		S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), {
			tone: "mid",
			inner: L(k.sideSeam(PLATE, -4, P, 8), { tone: "faint" }),
		}),
	)
	out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }))
	const screws = k.corners(PLATE, 11)
	out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }))
	out.push(
		D(
			screws.map(([x, y]) => at([x, y, 0])),
			{ size: 0.5 },
		),
	)
	return out.join("")
}

function strip() {
	const out = [S(k.slabOf(STRIP, 0, 0.6, P, 3), { tone: "lo", crease: "none" })]
	const ticks = k.topTicks(STRIP.x + 4, STRIP.x + STRIP.w - 4, 4, 5, STRIP.y + 0.6, 0.6, [1.8, 3.4], P)
	out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }))
	out.push(
		D([at([STRIP.x + 2, STRIP.y + 3, 0.6]), at([STRIP.x + STRIP.w - 2, STRIP.y + 3, 0.6])], {
			size: 0.45,
		}),
	)
	return out.join("")
}

// The fixture tank: one backend, one dataset, one warehouse, for both builds.
function tank() {
	const [x, y] = TANK
	const out = [halo({ x: x - 18, y: y - 18, w: 36, d: 36, r: 18 }, 0, 2, 6)]
	out.push(S(k.cylinder(x, y, TANK_R + 4, 0, 3, P, 56, 0.6), { tone: "lo" }))
	out.push(
		D(
			k.circleRing(x, y, TANK_R + 2, 12).map(([px, py]) => at([px, py, 3])),
			{ size: 0.45 },
		),
	)
	const bands = [16, 30, 44].map((z) => L(k.sideArc(x, y, TANK_R, z, P, 40), { tone: "faint" })).join("")
	out.push(S(k.cylinder(x, y, TANK_R, 3, TANK_TOP - 3, P, 56), { tone: "mid", inner: bands }))
	out.push(S(k.cylinder(x, y, TANK_R + 1.5, TANK_TOP, 3, P, 56, 0.6), { tone: "mid" }))
	out.push(L(k.ring(x, y, TANK_R - 3, TANK_TOP + 3, P, 48), { tone: "lo" }))
	out.push(
		D(
			k.circleRing(x, y, TANK_R - 0.5, 10).map(([px, py]) => at([px, py, TANK_TOP + 3])),
			{ size: 0.4 },
		),
	)
	out.push(S(k.cylinder(x, y, 3, TANK_TOP + 3, 3, P, 20), { tone: "mid" }))
	out.push(S(k.cylinder(x, y, 6, TANK_TOP + 6, 4, P, 32), { tone: "mid" }))
	out.push(L(k.knurl(x, y, 6, TANK_TOP + 6, TANK_TOP + 10, 30, P), { tone: "lo" }))
	out.push(L(k.lineOnTop([x, y], [x + 5, y], TANK_TOP + 10, P), { tone: "hi", free: "end" }))
	// Sight glass on the near side: the dataset level.
	const glass = { x: x - 2.5, y: y + TANK_R - 1, w: 5, d: 2.6, r: 1 }
	out.push(S(k.slabOf(glass, 8, 40, P, 3, 0.4), { tone: "lo" }))
	out.push(S(k.slabOf(k.insetPlan(glass, 0.9), 8.6, 30, P, 3), { tone: "hi", crease: "none" }))
	return out.join("")
}

function manifold() {
	const out = []
	out.push(
		S(
			k.slabOf(
				{ x: -4, y: TANK[1] + TANK_R - 2, w: 8, d: MANIFOLD.y - (TANK[1] + TANK_R - 2) + 1, r: 1.5 },
				4,
				6,
				P,
				3,
				0.4,
			),
			{ tone: "mid" },
		),
	)
	out.push(
		S(k.slabOf(MANIFOLD, 0, MANIFOLD_H, P, 4, 0.8), {
			tone: "mid",
			inner: L(k.sideSeam(MANIFOLD, 4, P, 4), { tone: "faint" }),
		}),
	)
	out.push(L(k.planOutline(k.insetPlan(MANIFOLD, 2.5), MANIFOLD_H, P, 3), { tone: "faint" }))
	out.push(
		D(
			k.corners(MANIFOLD, 4).map(([px, py]) => at([px, py, MANIFOLD_H])),
			{ size: 0.45 },
		),
	)
	return out.join("")
}

// Equal-length ducts: the same requests reach both builds.
function ducts() {
	const out = []
	BED_CX.forEach((cx, index) => {
		const inlet = inletPlan(cx)
		const from = index === 0 ? inlet.x + inlet.w : MANIFOLD.x + MANIFOLD.w
		const to = index === 0 ? MANIFOLD.x : inlet.x
		const plan = { x: from, y: DUCT_Y - DUCT_D / 2, w: to - from, d: DUCT_D, r: 1 }
		out.push(S(k.slabOf(plan, 0, DUCT_H, P, 3, 0.4), { tone: "mid" }))
		for (const bx of [plan.x + 10, plan.x + plan.w - 14]) {
			out.push(
				S(
					k.slabOf(
						{ x: bx, y: plan.y - 0.8, w: 4, d: DUCT_D + 1.6, r: 0.8 },
						0,
						DUCT_H + 0.8,
						P,
						3,
					),
					{ tone: "mid" },
				),
			)
		}
	})
	return out.join("")
}

const flowPath = (index) => {
	const cx = BED_CX[index]
	const inlet = inletPlan(cx)
	const a = index === 0 ? [MANIFOLD.x, DUCT_Y] : [MANIFOLD.x + MANIFOLD.w, DUCT_Y]
	const b = index === 0 ? [inlet.x + inlet.w, DUCT_Y] : [inlet.x, DUCT_Y]
	return k.lineOnTop(a, b, DUCT_H, P)
}

function stopwatch() {
	const [x, y] = WATCH
	const base = { x: x - 15, y: y - 15, w: 30, d: 30, r: 4 }
	const out = [halo(base, 0, 2, 6)]
	out.push(S(k.slabOf(base, 0, 4, P, 4, 0.6), { tone: "mid" }))
	out.push(
		D(
			k.corners(base, 3.5).map(([px, py]) => at([px, py, 4])),
			{ size: 0.45 },
		),
	)
	out.push(S(k.cylinder(x, y, WATCH_R, 4, 8, P, 56, 0.8), { tone: "hi", crease: "lo" }))
	out.push(L(k.knurl(x, y, WATCH_R, 9, 12, 60, P, 0.3), { tone: "lo" }))
	out.push(L(k.ring(x, y, WATCH_R - 2, 12, P, 48), { tone: "lo" }))
	const ticks = k.radialTicks(x, y, WATCH_R - 2.6, 60, 5, 12, [1, 2.2], P)
	out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }))
	// Crown on the far side with its stop lever pushed in: the clock does not run.
	out.push(S(k.slabOf({ x: x - 2, y: y - WATCH_R - 4, w: 4, d: 4.4, r: 1 }, 7, 3, P, 3), { tone: "mid" }))
	out.push(S(k.cylinder(x, y - WATCH_R - 5.6, 2.6, 6, 5, P, 20), { tone: "mid" }))
	out.push(
		S(k.slabOf({ x: x + 6, y: y - WATCH_R - 2.4, w: 3, d: 3.4, r: 0.8 }, 7, 3, P, 3), { tone: "mid" }),
	)
	// Both hands at the dataset's frozen now, 12:00.
	out.push(L(k.lineOnTop([x, y + 1.6], [x, y - (WATCH_R - 4)], 12.2, P), { tone: "lit", free: true }))
	out.push(L(k.lineOnTop([x, y + 1], [x, y - (WATCH_R - 6.5)], 12.2, P), { tone: "hi", free: true }))
	out.push(L(k.ring(x, y, 1.3, 12.2, P, 14), { tone: "mid" }))
	return out.join("")
}

function post(px) {
	const foot = { x: px - 9, y: BEAM_Y - 13, w: 18, d: 26, r: 2.5 }
	const out = [S(k.slabOf(foot, 0, 6, P, 4, 0.8), { tone: "mid" })]
	out.push(
		D(
			k.corners(foot, 3).map(([x, y]) => at([x, y, 6])),
			{ size: 0.45 },
		),
	)
	out.push(S(k.cylinder(px, BEAM_Y, 6, 6, 4, P, 28), { tone: "mid" }))
	const seams = [30, 56].map((z) => L(k.sideArc(px, BEAM_Y, 4, z, P, 16), { tone: "faint" })).join("")
	out.push(
		S(k.cylinder(px, BEAM_Y, 4, 10, BEAM_Z - 10, P, 28), { tone: "mid", crease: "none", inner: seams }),
	)
	return out.join("")
}

function beam() {
	const out = []
	out.push(
		S(k.slabOf(BEAM, BEAM_Z, BEAM_H, P, 3, 0.6), {
			tone: "mid",
			inner: L(k.sideSeam(BEAM, BEAM_Z + 3, P, 3), { tone: "faint" }),
		}),
	)
	const rail = { x: BEAM.x + 14, y: BEAM_Y - 1.5, w: BEAM.w - 28, d: 3, r: 1 }
	out.push(S(k.slabOf(rail, BEAM_Z + BEAM_H, 1.6, P, 3), { tone: "lo", crease: "none" }))
	for (const px of POST_X) {
		const cap = { x: px - 7, y: BEAM_Y - 7, w: 14, d: 14, r: 2 }
		out.push(S(k.slabOf(cap, BEAM_Z + BEAM_H, 3, P, 3, 0.5), { tone: "mid" }))
		out.push(
			D(
				k.corners(cap, 2.6).map(([x, y]) => at([x, y, BEAM_Z + BEAM_H + 3])),
				{ size: 0.45 },
			),
		)
	}
	for (const sx of [BEAM.x + 12, BEAM.x + BEAM.w - 16]) {
		out.push(
			S(k.slabOf({ x: sx, y: BEAM_Y - 4, w: 4, d: 8, r: 1 }, BEAM_Z + BEAM_H, 5, P, 3, 0.4), {
				tone: "mid",
			}),
		)
	}
	return out.join("")
}

// The capture head hangs under the beam; it is drawn before the beam, at x = 0, and moved.
function camera() {
	const out = []
	out.push(
		S(k.slabOf(CAM, CAM_Z, CAM_TOP - CAM_Z, P, 4, 0.6), {
			tone: "mid",
			inner: L(k.sideSeam(CAM, CAM_Z + 5, P, 4), { tone: "faint" }),
		}),
	)
	out.push(L(k.planOutline(k.insetPlan(CAM, 2.4), CAM_TOP, P, 3), { tone: "faint" }))
	out.push(
		S(k.slabOf({ x: -3, y: CAM.y + 3, w: 6, d: 8, r: 1 }, CAM_TOP, BEAM_Z - CAM_TOP, P, 3), {
			tone: "mid",
		}),
	)
	out.push(S(k.cylinder(0, BEAM_Y, LENS_R + 1.5, CAM_Z - 3, 3, P, 32), { tone: "mid" }))
	out.push(
		S(k.cylinder(0, BEAM_Y, LENS_R, LENS_Z, CAM_Z - 3 - LENS_Z, P, 32), {
			tone: "mid",
			inner: L(k.knurl(0, BEAM_Y, LENS_R, LENS_Z + 1, CAM_Z - 4, 28, P), { tone: "lo" }),
		}),
	)
	return out.join("")
}

function carriage() {
	const out = []
	const shoe = { x: -12, y: BEAM.y - 1.5, w: 24, d: BEAM.d + 3, r: 2 }
	out.push(S(k.slabOf(shoe, BEAM_Z + BEAM_H + 1.6, 4, P, 4, 0.6), { tone: "mid" }))
	out.push(
		D(
			k.corners(shoe, 3).map(([x, y]) => at([x, y, BEAM_Z + BEAM_H + 5.6])),
			{ size: 0.45 },
		),
	)
	const front = { x: -12, y: BEAM.y + BEAM.d, w: 24, d: 2.6, r: 0.8 }
	out.push(
		S(k.slabOf(front, CAM_TOP - 4, BEAM_Z + BEAM_H + 5.6 - (CAM_TOP - 4), P, 3, 0.4), { tone: "mid" }),
	)
	// The shutter lamp: lit while the head captures.
	out.push(
		`<g data-part="shutter">${S(k.cylinder(7, front.y + front.d + 1, 1.6, CAM_TOP + 6, 1.2, P, 16), { tone: "lo" })}</g>`,
	)
	out.push(
		S(k.cylinder(-6, front.y + front.d + 1.2, 2.4, BEAM_Z, 4, P, 20), {
			tone: "mid",
			inner: L(k.knurl(-6, front.y + front.d + 1.2, 2.4, BEAM_Z, BEAM_Z + 4, 14, P), { tone: "lo" }),
		}),
	)
	return out.join("")
}

function inlet(cx) {
	const plan = inletPlan(cx)
	return (
		S(k.slabOf(plan, 0, DUCT_H + 3, P, 3, 0.5), { tone: "mid" }) +
		D([at([plan.x + 3, plan.y + 3, DUCT_H + 3]), at([plan.x + plan.w - 3, plan.y + 3, DUCT_H + 3])], {
			size: 0.4,
		})
	)
}

const box = (x, y, w, d) => k.planOutline({ x, y, w, d, r: 0.8 }, SPEC_TOP, P, 2)

// The app shell both builds share: sidebar, header, nav items.
function shellUi(cx) {
	const s = screenPlan(cx)
	const z = SPEC_TOP
	const side = s.x + 18
	const head = s.y + 9
	const out = []
	out.push(L(k.lineOnTop([side, s.y], [side, s.y + s.d], z, P), { tone: "lo" }))
	out.push(L(k.lineOnTop([side, head], [s.x + s.w, head], z, P), { tone: "lo" }))
	for (const [index, len] of [10, 8, 11, 7, 9].entries()) {
		out.push(
			L(
				k.lineOnTop(
					[s.x + 3.5, s.y + 6 + index * 6.5],
					[s.x + 3.5 + len, s.y + 6 + index * 6.5],
					z,
					P,
				),
				{ tone: "lo", free: true },
			),
		)
	}
	out.push(L(k.lineOnTop([side + 4, s.y + 4.5], [side + 20, s.y + 4.5], z, P), { tone: "mid", free: true }))
	return out.join("")
}

// One content area per page, the same on both beds.
function pageUi(cx, page) {
	const s = screenPlan(cx)
	const z = SPEC_TOP
	const side = s.x + 18
	const head = s.y + 9
	const right = s.x + s.w
	const out = []
	const free = (a, b, tone = "lo") => out.push(L(k.lineOnTop(a, b, z, P), { tone, free: true }))
	if (page === 0) {
		for (let i = 0; i < 3; i++) {
			const x = side + 3 + i * 20.3
			out.push(L(box(x, head + 3, 18.3, 9), { tone: "lo" }))
			free([x + 2.5, head + 6], [x + 9, head + 6])
			free([x + 2.5, head + 9], [x + 13, head + 9], "mid")
		}
		const chart = [2, 4, 3, 6, 5, 8, 6, 10, 7, 9, 11].map((v, i, all) => [
			side + (i * (right - side)) / (all.length - 1),
			head + 29 - v * 1.2,
		])
		out.push(L(k.onTop(chart, z, P), { tone: "mid" }))
		out.push(L(k.lineOnTop([side, head + 32], [right, head + 32], z, P), { tone: "faint" }))
		for (const row of [head + 35, head + 38.5]) {
			free([side + 4, row], [side + 26, row])
			free([side + 34, row], [side + 44, row])
		}
	}
	if (page === 1) {
		const bars = [
			[0, 50],
			[4, 18],
			[8, 30],
			[10, 9],
			[22, 14],
			[26, 20],
			[40, 12],
		]
		bars.forEach(([offset, w], i) => {
			const y = head + 4 + i * 5.2
			out.push(L(k.lineOnTop([side, y + 3.6], [right, y + 3.6], z, P), { tone: "faint" }))
			out.push(L(box(side + 4 + offset, y, w, 2.4), { tone: i === 0 ? "mid" : "lo" }))
		})
	}
	if (page === 2) {
		for (let i = 0; i < 9; i++) {
			const y = head + 3.5 + i * 4.3
			const level = i === 3 || i === 7 ? "hi" : "lo"
			out.push(D([at([side + 3.2, y, z])], { size: i === 3 || i === 7 ? 0.9 : 0.6, tone: level }))
			free([side + 6, y], [side + 13, y], "mid")
			free([side + 16, y], [side + 16 + [38, 30, 42, 26, 35, 40, 22, 33, 28][i], y])
		}
	}
	if (page === 3) {
		const cells = [
			[side + 3, head + 3],
			[side + 33, head + 3],
			[side + 3, head + 22],
			[side + 33, head + 22],
		]
		cells.forEach(([x, y]) => out.push(L(box(x, y, 28, 16), { tone: "lo" })))
		const [ax, ay] = cells[0]
		out.push(
			L(
				k.onTop(
					[3, 6, 4, 9, 7, 11, 9].map((v, i) => [ax + 2 + i * 4, ay + 14 - v]),
					z,
					P,
				),
				{ tone: "mid", free: true },
			),
		)
		const [bx, by] = cells[1]
		;[6, 10, 4, 12, 8, 11].forEach((h, i) =>
			out.push(L(box(bx + 2.5 + i * 4.2, by + 14 - h, 2.6, h), { tone: "lo" })),
		)
		const [cx_, cy_] = cells[2]
		free([cx_ + 3, cy_ + 5], [cx_ + 12, cy_ + 5])
		free([cx_ + 3, cy_ + 10], [cx_ + 20, cy_ + 10], "hi")
		const [dx, dy] = cells[3]
		for (const row of [4, 7.5, 11]) free([dx + 3, dy + row], [dx + 22, dy + row])
	}
	return out.join("")
}

function bed(cx) {
	const plan = bedPlan(cx)
	const out = [halo(plan, 0, 2, 7)]
	out.push(S(k.slabOf(plan, 0, BED_H, P, 4, 0.8), { tone: "mid" }))
	out.push(L(k.planOutline(k.insetPlan(plan, 2.5), BED_H, P, 3), { tone: "faint" }))
	return out.join("")
}

// The screen card on a bed; it lifts out and the next page drops in.
function specimen(cx, index) {
	const spec = specPlan(cx)
	const out = [halo(spec, SPEC_Z, 1, 4)]
	out.push(S(k.slabOf(spec, SPEC_Z, SPEC_H, P, 3, 0.6), { tone: "hi", crease: "lo" }))
	out.push(
		`<path data-part="frame-${index}" class="iso-line" data-tone="lo" d="${k.planOutline(screenPlan(cx), SPEC_TOP, P, 3)}"/>`,
	)
	out.push(shellUi(cx))
	for (let page = 0; page < 4; page++) {
		const extra =
			page === 1
				? `<g data-part="button-${index}">${S(k.slabOf(buttonPlan(cx), BUTTON_Z, BUTTON_H, P, 3, 0.3), { tone: "hi", crease: "lo" })}</g>`
				: ""
		out.push(
			`<g data-page="${page}"${page === 0 ? "" : ' style="display:none"'}>${pageUi(cx, page)}${extra}</g>`,
		)
	}
	return `<g data-part="spec-${index}" class="pb-spec">${out.join("")}</g>`
}

// Corner dogs clamp the specimen in the same place on both beds. The far pair is drawn
// before the specimen and the near pair after, so a lifted card passes between them.
function dogs(cx, near) {
	const spec = specPlan(cx)
	const y = near ? spec.y + spec.d : spec.y - 5
	const out = []
	for (const x of [spec.x - 5, spec.x + spec.w]) {
		out.push(S(k.slabOf({ x, y, w: 5, d: 5, r: 1 }, BED_H, SPEC_H + 1.2, P, 3, 0.4), { tone: "mid" }))
		out.push(D([at([x + 2.5, y + 2.5, BED_H + SPEC_H + 1.2])], { size: 0.45 }))
	}
	return out.join("")
}

// While the head captures a bed, its field of view runs from the lens rim to the screen corners.
function cone(cx, index) {
	const s = screenPlan(cx)
	const lens = (dx, dy) => at([cx + dx, BEAM_Y + dy, LENS_Z])
	const corners = [
		[s.x, s.y, -1, -1],
		[s.x + s.w, s.y, 1, -1],
		[s.x, s.y + s.d, -1, 1],
		[s.x + s.w, s.y + s.d, 1, 1],
	]
	const d = corners
		.map(([x, y, sx, sy]) => {
			const [ax, ay] = lens(sx * LENS_R * 0.7, sy * LENS_R * 0.7)
			const [bx, by] = at([x, y, SPEC_TOP])
			return `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`
		})
		.join("")
	return `<path data-part="cone-${index}" class="iso-line pb-cone" data-tone="lit" d="${d}"/>`
}

function console_() {
	const out = [halo(CONSOLE, 0, CONSOLE_H)]
	out.push(
		S(k.slabOf(CONSOLE, 0, CONSOLE_H, P, 6, 1), {
			tone: "mid",
			inner: L(k.sideSeam(CONSOLE, 3.5, P, 6), { tone: "faint" }),
		}),
	)
	out.push(L(k.planOutline(k.insetPlan(CONSOLE, 3), CONSOLE_H, P, 4), { tone: "faint" }))
	out.push(
		D(
			k.corners(CONSOLE, 6).map(([x, y]) => at([x, y, CONSOLE_H])),
			{ size: 0.45 },
		),
	)
	return out.join("")
}

const needleOf = (x, share) => {
	const angle = share * Math.PI * 2
	return k.lineOnTop(
		[x - Math.sin(angle) * 2.6, GAUGE_Y + Math.cos(angle) * 2.6],
		[x + Math.sin(angle) * (GAUGE_R - 3.6), GAUGE_Y - Math.cos(angle) * (GAUGE_R - 3.6)],
		GAUGE_TOP + 0.2,
		P,
	)
}

function gauge(x, index) {
	const out = []
	out.push(S(k.cylinder(x, GAUGE_Y, GAUGE_R + 2, GAUGE_Z, 2, P, 48), { tone: "mid" }))
	out.push(
		S(k.cylinder(x, GAUGE_Y, GAUGE_R, GAUGE_Z + 2, GAUGE_H - 2, P, 64, 0.8), {
			tone: "hi",
			crease: "lo",
			inner: L(k.knurl(x, GAUGE_Y, GAUGE_R, GAUGE_TOP - 3, GAUGE_TOP, 72, P, 0.3), { tone: "lo" }),
		}),
	)
	out.push(L(k.ring(x, GAUGE_Y, GAUGE_R - 2, GAUGE_TOP, P, 56), { tone: "lo" }))
	const ticks = k.radialTicks(x, GAUGE_Y, GAUGE_R - 2.6, 40, 5, GAUGE_TOP, [1, 2.2], P)
	out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }))
	out.push(
		L(k.lineOnTop([x, GAUGE_Y - (GAUGE_R - 2)], [x, GAUGE_Y - (GAUGE_R - 5.2)], GAUGE_TOP + 0.1, P), {
			tone: "hi",
		}),
	)
	out.push(
		`<path data-part="needle-${index}" class="iso-line" data-tone="lit" data-free="start" d="${needleOf(x, 0)}" style="stroke-width:1.1"/>`,
	)
	out.push(L(k.ring(x, GAUGE_Y, 1.4, GAUGE_TOP + 0.2, P, 14), { tone: "mid" }))
	return out.join("")
}

function lamp() {
	const [x, y] = LAMP
	const out = []
	out.push(S(k.cylinder(x, y, 10, CONSOLE_H, 2.4, P, 40, 0.5), { tone: "mid" }))
	out.push(
		D(
			k.circleRing(x, y, 8.4, 6).map(([px, py]) => at([px, py, CONSOLE_H + 2.4])),
			{ size: 0.4 },
		),
	)
	out.push(S(k.cylinder(x, y, 7.4, CONSOLE_H + 2.4, 3, P, 40), { tone: "mid" }))
	out.push(
		`<g data-part="lamp" class="pb-lamp" data-state="ok">${S(k.cylinder(x, y, 5.6, CONSOLE_H + 5.4, 4.2, P, 40, 0.5), { tone: "hi", crease: "lo" })}</g>`,
	)
	return out.join("")
}

// One light per page: green once its last run was identical, red while it fails.
const LED_X = [106, 118, 130, 142]
function tally() {
	const out = []
	const rail = { x: LED_X[0] - 7, y: GAUGE_Y - 6, w: LED_X[3] - LED_X[0] + 14, d: 12, r: 2 }
	out.push(S(k.slabOf(rail, CONSOLE_H, 1.4, P, 3, 0.4), { tone: "mid" }))
	out.push(
		D(
			[
				at([rail.x + 2.4, GAUGE_Y, CONSOLE_H + 1.4]),
				at([rail.x + rail.w - 2.4, GAUGE_Y, CONSOLE_H + 1.4]),
			],
			{ size: 0.45 },
		),
	)
	LED_X.forEach((x, index) => {
		out.push(S(k.cylinder(x, GAUGE_Y, 4, CONSOLE_H + 1.4, 1.2, P, 28), { tone: "mid" }))
		out.push(
			`<g data-part="led-${index}" class="pb-lamp" data-state="idle">${S(k.cylinder(x, GAUGE_Y, 2.8, CONSOLE_H + 2.6, 2.2, P, 28, 0.3), { tone: "hi", crease: "lo" })}</g>`,
		)
	})
	return out.join("")
}

const svg = k.figureSvg({
	width: WIDTH,
	height: HEIGHT,
	className: "pb-svg",
	label: "A comparator bench. One fixture tank at the back feeds two equal ducts into two identical test beds: the React build on the left, the Foldkit build on the right. Both beds show the same page of the app; after each run the screens lift out and the next page drops in. A stopwatch beside the tank is locked at 12:00. A camera runs on a gantry over both beds and photographs each screen; four dial gauges on the front console read the pixel, structure, call-log and accessibility differences, a lamp shows whether the two are identical, and four small lights record which pages have passed.",
	body: [
		plate(),
		tank(),
		stopwatch(),
		manifold(),
		ducts(),
		L(flowPath(0), { tone: "mid", flow: true, className: "pb-flow" }),
		`<path data-part="flow-1" class="iso-line pb-flow" data-tone="mid" data-flow="" d="${flowPath(1)}"/>`,
		inlet(BED_CX[0]),
		inlet(BED_CX[1]),
		post(POST_X[0]),
		bed(BED_CX[0]),
		dogs(BED_CX[0], false),
		specimen(BED_CX[0], 0),
		dogs(BED_CX[0], true),
		bed(BED_CX[1]),
		dogs(BED_CX[1], false),
		specimen(BED_CX[1], 1),
		dogs(BED_CX[1], true),
		cone(BED_CX[0], 0),
		cone(BED_CX[1], 1),
		post(POST_X[1]),
		`<g data-part="camera" transform="${k.translateAlong(P, [BED_CX[0], 0, 0])}">${camera()}</g>`,
		beam(),
		`<g data-part="carriage" transform="${k.translateAlong(P, [BED_CX[0], 0, 0])}">${carriage()}</g>`,
		console_(),
		...byDepth(GAUGE_X.map((x) => [x, GAUGE_Y])).map(([x]) => gauge(x, GAUGE_X.indexOf(x))),
		lamp(),
		tally(),
		strip(),
	],
})

const data = {
	P,
	BED_CX,
	GAUGE_X,
	GAUGE_Y,
	GAUGE_R,
	GAUGE_TOP,
}

mkdirSync(OUT, { recursive: true })
writeFileSync(
	join(FIG_DIR, "parity-bench.data.mjs"),
	`// Generated by apps/landing/scripts/figures/parity-bench.mjs. Do not edit.\nexport const BENCH = ${JSON.stringify(data)}\nexport const BENCH_SVG = ${JSON.stringify(svg)}\n`,
)

const stripExports = (source) => source.replace(/^export /gm, "").replace(/^import .*$/gm, "")
const live = stripExports(readFileSync(join(FIG_DIR, "parity-bench.live.mjs"), "utf8"))
const model = stripExports(readFileSync(join(FIG_DIR, "parity-bench.model.mjs"), "utf8"))
const kitSource = stripExports(readFileSync(join(FIG_DIR, "iso/iso-kit.mjs"), "utf8"))
const body = k.plateHtml({
	fig: "Fig 1",
	title: "Parity bench",
	hint: "Click to run the next comparison",
	readout: "",
	keys: [],
	caption: "",
	body: `<div class="iso-stage pb-stage" tabindex="0" role="button" aria-label="Parity bench: press Enter to run the next comparison">${svg}</div>`,
})
const extraCss = readFileSync(join(FIG_DIR, "parity-bench.css"), "utf8")
const page = k
	.pageHtml({
		title: "Parity bench",
		theme,
		body,
		script: `${kitSource}\nconst BENCH = ${JSON.stringify(data)};\n${model}\n${live}\nmountParityBench(document.querySelector(".pb-stage"), document.querySelector("[data-readout]"));`,
	})
	.replace("</style>", `${extraCss}</style>`)
writeFileSync(join(OUT, theme === "light" ? "page-light.html" : "page.html"), page)
console.log("wrote", join(FIG_DIR, "parity-bench.data.mjs"), "and", OUT)
