// Pixel-grid maple leaves for the crash page, ported from the landing 404
// (`apps/landing/src/lib/maple-leaves.ts`). They sway down, settle into a pile
// and dissolve; the pointer blows wind and pressing an action sweeps them off.

type Rgb = readonly [number, number, number]

interface Leaf {
	id: number
	x: number
	y: number
	z: number
	tumble: boolean
	size: number
	phase: number
	omega: number
	amp: number
	vf: number
	gx: number
	gy: number
	baseRot: number
	rot: number
	rotV: number
	flip: number
	flipV: number
	asx: number
	back: boolean
	pal: readonly Rgb[]
	groundY: number
	resting: boolean
	sy: number
	restRot: number
	age: number
	life: number
	alpha: number
}

interface Bit {
	x: number
	y: number
	vx: number
	vy: number
	life: number
	max: number
	dot: boolean
}

const hex = (h: string): Rgb => [
	Number.parseInt(h.slice(1, 3), 16),
	Number.parseInt(h.slice(3, 5), 16),
	Number.parseInt(h.slice(5, 7), 16),
]

const PALETTES: readonly (readonly Rgb[])[] = [
	["#f2c14e", "#e8892c", "#c9412a"],
	["#f0a03c", "#d9542b", "#a8281f"],
	["#e9c46a", "#e9a23b", "#d0702a"],
	["#d8452c", "#b52a22", "#7e1d1a"],
	["#f4d35e", "#f0b73f", "#e07a2e"],
	["#c98b4a", "#a5612f", "#6e3b22"],
].map((p) => p.map(hex))
const STEM = hex("#6b4226")
const CHARS = ["-", "|", "/", "\\"]

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function hash(i: number, j: number, k: number) {
	let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1442695041)
	n = Math.imul(n ^ (n >>> 13), 1274126177)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

// Maple leaf as a polar shape: five pointy lobes, serrated edges, deep notch at the stem.
const UP = -Math.PI / 2
const LOBES: readonly (readonly [number, number])[] = [
	[UP, 0.76],
	[UP - 0.95, 0.64],
	[UP + 0.95, 0.64],
	[UP - 1.9, 0.38],
	[UP + 1.9, 0.38],
]
const RT = new Float32Array(512).map((_, k) => {
	const th = (k / 512) * Math.PI * 2 - Math.PI
	const r = LOBES.reduce((acc, [a, amp]) => {
		const c = Math.cos(th - a)
		return c > 0 ? Math.max(acc, 0.2 + amp * c ** 14) : acc
	}, 0.2)
	return r + 0.06 * Math.abs(Math.sin(th * 13)) ** 3 * ((r - 0.2) / 0.76)
})
const radiusAt = (th: number) => RT[Math.min(511, Math.floor(((th + Math.PI) / (Math.PI * 2)) * 512))] ?? 0.2

export interface MapleLeavesOptions {
	/** Fraction of the width (0..1) where most leaves start, to keep them clear of copy on the left. */
	readonly spawnFrom?: number
}

/** Starts the leaves on `canvas`, with `host` as the pointer surface; returns the teardown. */
export function mountMapleLeaves(
	canvas: HTMLCanvasElement,
	host: HTMLElement,
	{ spawnFrom = 0 }: MapleLeavesOptions = {},
): () => void {
	const ctx = canvas.getContext("2d")
	if (!ctx) return () => {}
	const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)")

	const grid = {
		cell: 10,
		w: 0,
		h: 0,
		floor: 0,
		cols: 0,
		rows: 0,
		color: new Int32Array(0),
		alpha: new Float32Array(0),
		glyph: new Uint8Array(0),
		glyphA: new Float32Array(0),
	}
	const leaves: Leaf[] = []
	const bits: Bit[] = []
	const mouse = { x: -1e4, y: -1e4, vx: 0, vy: 0, last: 0 }
	const state = { nextId: 1, last: performance.now(), raf: 0, visible: true, ink: "currentColor" }

	const narrow = () => grid.w < 768
	const maxAirborne = () => (narrow() ? 6 : 14)

	function resize() {
		const r = host.getBoundingClientRect()
		const dpr = Math.min(2, window.devicePixelRatio || 1)
		grid.w = r.width
		grid.h = r.height
		grid.floor = grid.h - 18
		grid.cell = narrow() ? 8 : 10
		canvas.width = Math.round(grid.w * dpr)
		canvas.height = Math.round(grid.h * dpr)
		ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
		grid.cols = Math.ceil(grid.w / grid.cell)
		grid.rows = Math.ceil(grid.h / grid.cell)
		const n = grid.cols * grid.rows
		grid.color = new Int32Array(n)
		grid.alpha = new Float32Array(n)
		grid.glyph = new Uint8Array(n)
		grid.glyphA = new Float32Array(n)
		// Canvas takes any CSS colour, so the wind marks follow the theme's foreground.
		state.ink = getComputedStyle(host).color
		for (const l of leaves) l.groundY = groundFor(l.z)
		if (reducedMotion.matches) draw()
	}

	const groundFor = (z: number) => grid.floor - (1 - z) * 22 - rand(0, 10)
	const spawnX = () =>
		Math.random() < 0.88 ? rand(grid.w * spawnFrom, grid.w + 40) : rand(-40, grid.w * spawnFrom)

	function spawn(x: number, y: number, resting = false) {
		const z = Math.random() ** 0.7
		const big = narrow() ? 0.7 : 1
		const leaf: Leaf = {
			id: state.nextId++,
			x,
			y,
			z,
			tumble: Math.random() < 0.22,
			size: (lerp(28, 62, z) + rand(0, lerp(12, 40, z))) * big,
			phase: rand(0, Math.PI * 2),
			omega: rand(0.75, 1.1),
			amp: rand(34, 64),
			vf: rand(26, 38),
			gx: 0,
			gy: 0,
			baseRot: rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI),
			rot: 0,
			rotV: rand(0.8, 1.6) * (Math.random() < 0.5 ? -1 : 1),
			flip: rand(0, Math.PI * 2),
			flipV: rand(1.2, 2.2),
			asx: 1,
			back: false,
			pal: PALETTES[Math.floor(Math.random() * PALETTES.length)] ?? PALETTES[0]!,
			groundY: groundFor(z),
			resting,
			sy: 1,
			restRot: rand(-0.4, 0.4) + (Math.random() < 0.5 ? 0 : Math.PI),
			age: 0,
			life: rand(22, 40),
			alpha: 1,
		}
		leaf.rot = leaf.baseRot
		if (resting) {
			leaf.y = leaf.groundY
			leaf.sy = 0.42
			leaf.rot = leaf.restRot
			leaf.age = rand(0, 15)
		}
		leaves.push(leaf)
	}

	const bit = (x: number, y: number, vx: number, vy: number, life: number, dot: boolean) =>
		bits.push({ x, y, vx, vy, life, max: life, dot })

	function liftOff(l: Leaf) {
		l.resting = false
		l.age = 0
		l.baseRot = l.rot
	}

	function local(e: PointerEvent) {
		const r = host.getBoundingClientRect()
		return { x: e.clientX - r.left, y: e.clientY - r.top }
	}

	function onMove(e: PointerEvent) {
		const { x, y } = local(e)
		if (mouse.x > -1e3) {
			mouse.vx = x - mouse.x
			mouse.vy = y - mouse.y
		}
		mouse.x = x
		mouse.y = y
		const now = performance.now()
		if (Math.hypot(mouse.vx, mouse.vy) > 4 && now - mouse.last > 45) {
			mouse.last = now
			bit(x + rand(-10, 10), y + rand(-10, 10), mouse.vx * 2, mouse.vy * 2, 0.7, false)
		}
	}
	function onLeave() {
		mouse.x = mouse.y = -1e4
		mouse.vx = mouse.vy = 0
	}

	// Pressing Reload or Back to home clears the ground: one gust carries every leaf off to the right.
	function gust() {
		for (const l of leaves) {
			if (l.resting) liftOff(l)
			l.gx += rand(260, 420) * (0.6 + 0.4 * l.z)
			l.gy -= rand(60, 140)
		}
		for (let k = 0; k < 18; k++)
			bit(rand(0, grid.w * 0.5), rand(grid.h * 0.3, grid.h), rand(320, 520), rand(-60, 0), 0.9, false)
	}

	function onDown(e: PointerEvent) {
		const target = e.target instanceof Element ? e.target : null
		if (target?.closest("[data-crash-gust]")) {
			gust()
			return
		}
		if (target?.closest("a, button, input, [role=button]")) return
		const { x, y } = local(e)
		for (let k = 0; k < 14; k++) {
			const a = (k / 14) * Math.PI * 2
			bit(x, y, Math.cos(a) * 90, Math.sin(a) * 90, 0.8, false)
		}
		for (const l of leaves) {
			const dx = l.x - x
			const dy = l.y - y
			const d = Math.hypot(dx, dy)
			if (d > 220) continue
			const f = (1 - d / 220) * 150
			if (l.resting) liftOff(l)
			l.gx += (dx / (d + 1)) * f
			l.gy += (dy / (d + 1)) * f - (l.resting ? 60 : 30)
		}
	}

	function step(dt: number, t: number) {
		const airborne = leaves.filter((l) => !l.resting).length
		if (airborne < maxAirborne() && leaves.length < 30 && Math.random() < dt * 0.9) spawn(spawnX(), -80)

		const wind = 6 + Math.sin(t * 0.07) * 8
		const sp = Math.hypot(mouse.vx, mouse.vy)
		for (const l of leaves) {
			const dx = l.x - mouse.x
			const dy = l.y - mouse.y
			const d = Math.hypot(dx, dy)
			if (d < 140 && sp > 1) {
				const f = 1 - d / 140
				if (l.resting && sp > 9) {
					liftOff(l)
					l.gy -= 40 + sp * 2
				}
				if (!l.resting) {
					l.gx += mouse.vx * f * 0.35
					l.gy += mouse.vy * f * 0.25
				}
			}

			if (l.resting) {
				const k = Math.min(1, dt * 5)
				l.sy = lerp(l.sy, 0.42, k)
				l.rot = lerp(l.rot, l.restRot, k)
				l.asx = lerp(l.asx, 1, k)
				l.back = false
				l.age += dt
				if (l.age > l.life) l.alpha -= dt * 0.2
				continue
			}

			const depth = 0.45 + 0.55 * l.z
			l.phase += l.omega * dt
			const sw = Math.cos(l.phase)
			l.sy = lerp(l.sy, 1, Math.min(1, dt * 3))
			let vx: number
			let vy: number
			if (l.tumble) {
				// spins end over end and drops a little quicker, barely swaying
				l.rot += l.rotV * dt
				l.flip += l.flipV * dt
				l.asx = Math.max(0.14, Math.abs(Math.cos(l.flip)))
				l.back = Math.cos(l.flip) < 0
				vx = l.amp * 0.3 * l.omega * sw
				vy = l.vf * 1.15
			} else {
				// pendulum: fastest drop mid-swing, nearly hangs at each end while tilted
				l.rot = l.baseRot + 0.6 * Math.sin(l.phase)
				l.asx = 0.62 + 0.38 * Math.abs(sw)
				l.back = false
				vx = l.amp * l.omega * sw
				vy = l.vf * (0.12 + 1.15 * sw * sw)
			}
			l.x += ((vx + wind) * depth + l.gx) * dt
			l.y += (vy * depth + l.gy) * dt
			l.gx *= 1 - Math.min(1, dt * 1.1)
			l.gy *= 1 - Math.min(1, dt * 1.4)

			if (l.y >= l.groundY && l.gy >= 0) {
				l.y = l.groundY
				l.resting = true
				l.restRot =
					(Math.abs(Math.sin(l.rot)) < 0.7 ? Math.round(l.rot / Math.PI) * Math.PI : l.rot) +
					rand(-0.3, 0.3)
				for (let k = 0; k < 3; k++)
					bit(l.x + rand(-l.size, l.size) * 0.6, l.y, rand(-20, 20), rand(-30, -12), 0.7, true)
			}
		}
		mouse.vx *= 0.85
		mouse.vy *= 0.85

		const resting = leaves.filter((l) => l.resting)
		const oldest = resting.length > 18 ? resting.reduce((a, b) => (b.age > a.age ? b : a)) : undefined
		if (oldest) oldest.age = Math.max(oldest.age, oldest.life)

		for (let k = leaves.length - 1; k >= 0; k--) {
			const l = leaves[k]!
			if (l.alpha <= 0 || l.x < -160 || l.x > grid.w + 160 || l.y < -300) leaves.splice(k, 1)
		}
		for (let k = bits.length - 1; k >= 0; k--) {
			const b = bits[k]!
			b.x += b.vx * dt
			b.y += b.vy * dt
			b.vx *= 1 - Math.min(1, dt * 2.5)
			b.vy *= 1 - Math.min(1, dt * 2.5)
			b.life -= dt
			if (b.life <= 0) bits.splice(k, 1)
		}
	}

	function rasterize(l: Leaf) {
		const { cell, cols, rows, color, alpha } = grid
		const s = l.size
		const ca = Math.cos(-l.rot)
		const sa = Math.sin(-l.rot)
		const shade = 0.72 + 0.28 * l.asx
		// Far leaves sink into the page by transparency, so the same pixels work on light and dark.
		const depthAlpha = 1 - (1 - l.z) * 0.45
		const veinW = 0.5 / (s / cell)
		const i0 = Math.max(0, Math.floor((l.x - s) / cell))
		const i1 = Math.min(cols - 1, Math.ceil((l.x + s) / cell))
		const j0 = Math.max(0, Math.floor((l.y - s) / cell))
		const j1 = Math.min(rows - 1, Math.ceil((l.y + s) / cell))
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) {
				if (hash(i, j, l.id) > l.alpha) continue
				const px = (i + 0.5) * cell - l.x
				const py = ((j + 0.5) * cell - l.y) / l.sy
				const u = (px * ca - py * sa) / s / l.asx
				const v = (px * sa + py * ca) / s
				const rho = Math.hypot(u, v)
				if (rho > 1) continue
				const th = Math.atan2(v, u)
				const edge = radiusAt(th)
				let rgb: Rgb
				if (rho < edge) {
					const t = rho / edge
					const vein = LOBES.some(
						([a]) =>
							Math.cos(th - a) > 0 &&
							rho * Math.abs(Math.sin(th - a)) < veinW &&
							rho < edge * 0.85,
					)
					rgb = l.pal[vein ? 2 : t < 0.42 ? 0 : t < 0.78 ? 1 : 2] ?? STEM
				} else if (Math.abs(u) < veinW && v > 0 && v < 0.62) {
					rgb = STEM
				} else continue
				const lift = l.back ? 0.8 : 1
				const r = Math.min(255, rgb[0] * lift * shade + (l.back ? 48 : 0))
				const g = Math.min(255, rgb[1] * lift * shade + (l.back ? 40 : 0))
				const b = Math.min(255, rgb[2] * lift * shade + (l.back ? 30 : 0))
				const idx = j * cols + i
				color[idx] = (r << 16) | (g << 8) | b
				alpha[idx] = depthAlpha
			}
		}
	}

	function rasterizeBit(b: Bit) {
		const { cell, cols, rows, glyph, glyphA } = grid
		const i = Math.floor(b.x / cell)
		const j = Math.floor(b.y / cell)
		if (i < 0 || j < 0 || i >= cols || j >= rows) return
		const sp = Math.hypot(b.vx, b.vy) || 1
		const c = b.vx / sp
		const s = b.vy / sp
		const k = b.dot ? 4 : Math.abs(c) > 0.92 ? 0 : Math.abs(s) > 0.92 ? 1 : c * s > 0 ? 3 : 2
		const a = b.life / b.max
		const idx = j * cols + i
		if (a > (glyphA[idx] ?? 0)) {
			glyph[idx] = k + 1
			glyphA[idx] = a
		}
	}

	function draw() {
		if (!ctx) return
		const { cell, cols, color, alpha, glyph, glyphA } = grid
		ctx.clearRect(0, 0, grid.w, grid.h)
		color.fill(-1)
		glyph.fill(0)
		glyphA.fill(0)
		leaves.sort((a, b) => a.z - b.z)
		for (const l of leaves) rasterize(l)
		for (const b of bits) rasterizeBit(b)

		const g = cell - 1
		for (let idx = 0; idx < color.length; idx++) {
			const c = color[idx] ?? -1
			if (c < 0) continue
			ctx.globalAlpha = alpha[idx] ?? 1
			ctx.fillStyle = `rgb(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255})`
			ctx.fillRect((idx % cols) * cell, Math.floor(idx / cols) * cell, g, g)
		}
		ctx.font = `${cell + 1}px ui-monospace, Menlo, monospace`
		ctx.textAlign = "center"
		ctx.textBaseline = "middle"
		ctx.fillStyle = state.ink
		for (let idx = 0; idx < glyph.length; idx++) {
			const k = glyph[idx] ?? 0
			if (!k || (color[idx] ?? -1) >= 0) continue
			ctx.globalAlpha = (glyphA[idx] ?? 0) * 0.45
			ctx.fillText(
				k === 5 ? "." : (CHARS[k - 1] ?? "-"),
				(idx % cols) * cell + cell / 2,
				Math.floor(idx / cols) * cell + cell / 2,
			)
		}
		ctx.globalAlpha = 1
	}

	function frame(now: number) {
		const dt = Math.min(0.05, (now - state.last) / 1000)
		state.last = now
		step(dt, now / 1000)
		draw()
		state.raf = requestAnimationFrame(frame)
	}

	// Reduced motion draws one still frame (a few leaves caught mid-fall, a small pile) and never animates.
	function setRunning(run: boolean) {
		cancelAnimationFrame(state.raf)
		if (!run || reducedMotion.matches) return
		state.last = performance.now()
		state.raf = requestAnimationFrame(frame)
	}

	resize()
	if (reducedMotion.matches) {
		for (let k = 0; k < (narrow() ? 3 : 6); k++) spawn(spawnX(), rand(grid.h * 0.1, grid.h * 0.7))
		for (let k = 0; k < (narrow() ? 4 : 8); k++) spawn(spawnX(), 0, true)
		draw()
	} else {
		// The crash itself: a flurry already on its way down, staggered above the fold, and no pile yet.
		for (let k = 0; k < (narrow() ? 6 : 12); k++) spawn(spawnX(), rand(-grid.h * 0.6, grid.h * 0.25))
	}

	const ro = new ResizeObserver(resize)
	ro.observe(host)
	const io = new IntersectionObserver(([entry]) => {
		state.visible = entry?.isIntersecting ?? true
		setRunning(state.visible && !document.hidden)
	})
	io.observe(host)
	const onVisibility = () => setRunning(state.visible && !document.hidden)
	document.addEventListener("visibilitychange", onVisibility)
	host.addEventListener("pointermove", onMove)
	host.addEventListener("pointerleave", onLeave)
	host.addEventListener("pointerdown", onDown)
	setRunning(true)

	return () => {
		setRunning(false)
		ro.disconnect()
		io.disconnect()
		document.removeEventListener("visibilitychange", onVisibility)
		host.removeEventListener("pointermove", onMove)
		host.removeEventListener("pointerleave", onLeave)
		host.removeEventListener("pointerdown", onDown)
	}
}
