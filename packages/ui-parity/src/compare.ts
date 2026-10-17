import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"
import type { CallLogEntry } from "./contract.ts"
import { type AriaDelta, diffAria, diffCallLogs } from "./behavior.ts"
import type { DomSnapshot, Rect, SnapshotNode } from "./runtime/snapshot.ts"

/** What `capture.ts` writes per variant: the structural snapshot plus the call log and ARIA tree. */
type CaptureSnapshot = DomSnapshot & { readonly calls?: ReadonlyArray<CallLogEntry>; readonly aria?: string }

/**
 * Compares one variant captured by a baseline target and a candidate target.
 *
 * Three layers, from "is it identical" to "what exactly to change":
 * 1. pixels: strict (any channel difference) and perceptual (pixelmatch, AA ignored)
 * 2. regions: differing pixels clustered into boxes, largest first
 * 3. structure: text runs + controls paired by identity, with box and style deltas,
 *    attached to the regions they overlap
 * Plus behavior (backend calls, fails the variant) and accessibility (ARIA tree, reported only
 * unless `strictA11y`).
 */

export interface StyleDelta {
	readonly prop: string
	readonly baseline: string
	readonly candidate: string
}

export interface NodeDelta {
	readonly kind: SnapshotNode["kind"]
	readonly key: string
	readonly label: string
	readonly path: { readonly baseline: string; readonly candidate: string }
	readonly rect: { readonly baseline: Rect; readonly candidate: Rect }
	readonly moved: { readonly dx: number; readonly dy: number; readonly dw: number; readonly dh: number }
	readonly styles: ReadonlyArray<StyleDelta>
}

export interface Region extends Rect {
	readonly pixels: number
	/** Keys of node deltas / unmatched nodes overlapping this region. */
	readonly nodes: ReadonlyArray<string>
}

export interface VariantComparison {
	readonly variantId: string
	readonly status: "identical" | "pass" | "fail" | "missing"
	/** Status from pixels alone, before behavior (and strict a11y) are taken into account. */
	readonly visualStatus: "identical" | "pass" | "fail" | "missing"
	readonly width: number
	readonly height: number
	readonly sizeMismatch: boolean
	readonly strictPixels: number
	readonly perceptualPixels: number
	readonly mismatchPercent: number
	readonly regions: ReadonlyArray<Region>
	readonly deltas: ReadonlyArray<NodeDelta>
	readonly missingInCandidate: ReadonlyArray<SnapshotNode>
	readonly extraInCandidate: ReadonlyArray<SnapshotNode>
	/** Call-log differences, one readable line each; any line fails the variant. */
	readonly behavior: ReadonlyArray<string>
	readonly a11y: AriaDelta
	readonly diffImage?: string
}

const readPng = (path: string) => PNG.sync.read(readFileSync(path))

/** Pads an image onto a transparent-magenta canvas so size mismatches show up loudly. */
const padTo = (png: PNG, width: number, height: number) => {
	if (png.width === width && png.height === height) return png.data
	const out = Buffer.alloc(width * height * 4)
	for (let i = 0; i < out.length; i += 4) out.set([255, 0, 255, 255], i)
	for (let y = 0; y < png.height; y++) {
		png.data.copy(out, y * width * 4, y * png.width * 4, (y + 1) * png.width * 4)
	}
	return out
}

const countStrict = (a: Buffer, b: Buffer) => {
	let count = 0
	for (let i = 0; i < a.length; i += 4) {
		if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) count++
	}
	return count
}

const CELL = 12

/** Clusters diff pixels (red in pixelmatch output) into connected boxes on a coarse grid. */
const findRegions = (diff: Buffer, width: number, height: number): Array<Omit<Region, "nodes">> => {
	const cols = Math.ceil(width / CELL)
	const rows = Math.ceil(height / CELL)
	const cells = new Uint32Array(cols * rows)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			// pixelmatch paints differences in diffColor (255,0,0) and diffColorAlt (0,255,0 by default here)
			if (
				(diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0) ||
				(diff[i] === 0 && diff[i + 1] === 200 && diff[i + 2] === 0)
			) {
				const cell = Math.floor(y / CELL) * cols + Math.floor(x / CELL)
				cells[cell] = (cells[cell] ?? 0) + 1
			}
		}
	}
	const seen = new Uint8Array(cols * rows)
	const regions: Array<Omit<Region, "nodes">> = []
	for (let start = 0; start < cells.length; start++) {
		if (!cells[start] || seen[start]) continue
		let minC = cols,
			minR = rows,
			maxC = 0,
			maxR = 0,
			pixels = 0
		const stack = [start]
		seen[start] = 1
		for (let cell = stack.pop(); cell !== undefined; cell = stack.pop()) {
			const c = cell % cols
			const r = Math.floor(cell / cols)
			pixels += cells[cell] ?? 0
			minC = Math.min(minC, c)
			maxC = Math.max(maxC, c)
			minR = Math.min(minR, r)
			maxR = Math.max(maxR, r)
			for (const [dc, dr] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
				[1, 1],
				[-1, -1],
				[1, -1],
				[-1, 1],
			] as const) {
				const nc = c + dc
				const nr = r + dr
				if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
				const next = nr * cols + nc
				if (cells[next] && !seen[next]) {
					seen[next] = 1
					stack.push(next)
				}
			}
		}
		regions.push({
			x: minC * CELL,
			y: minR * CELL,
			width: Math.min((maxC + 1) * CELL, width) - minC * CELL,
			height: Math.min((maxR + 1) * CELL, height) - minR * CELL,
			pixels,
		})
	}
	return regions.sort((a, b) => b.pixels - a.pixels)
}

const overlaps = (a: Rect, b: Rect) =>
	a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

const POSITION_TOLERANCE = 0.5

export const diffSnapshots = (baseline: DomSnapshot, candidate: DomSnapshot) => {
	const candidateByKey = new Map(candidate.nodes.map((node) => [node.key, node]))
	const baselineKeys = new Set(baseline.nodes.map((node) => node.key))
	const deltas: NodeDelta[] = []
	const missingInCandidate: SnapshotNode[] = []

	for (const base of baseline.nodes) {
		const cand = candidateByKey.get(base.key)
		if (!cand) {
			missingInCandidate.push(base)
			continue
		}
		const moved = {
			dx: Math.round((cand.rect.x - base.rect.x) * 10) / 10,
			dy: Math.round((cand.rect.y - base.rect.y) * 10) / 10,
			dw: Math.round((cand.rect.width - base.rect.width) * 10) / 10,
			dh: Math.round((cand.rect.height - base.rect.height) * 10) / 10,
		}
		const styles = Object.keys(base.styles)
			.filter((prop) => base.styles[prop] !== cand.styles[prop])
			.map((prop) => ({
				prop,
				baseline: base.styles[prop] ?? "(unset)",
				candidate: cand.styles[prop] ?? "(unset)",
			}))
		const isMoved = Object.values(moved).some((value) => Math.abs(value) > POSITION_TOLERANCE)
		if (isMoved || styles.length > 0) {
			deltas.push({
				kind: base.kind,
				key: base.key,
				label: base.label,
				path: { baseline: base.path, candidate: cand.path },
				rect: { baseline: base.rect, candidate: cand.rect },
				moved,
				styles,
			})
		}
	}
	const extraInCandidate = candidate.nodes.filter((node) => !baselineKeys.has(node.key))
	return { deltas, missingInCandidate, extraInCandidate }
}

export const compareVariant = (options: {
	readonly variantId: string
	readonly baselineDir: string
	readonly candidateDir: string
	readonly outDir: string
	/** Perceptual pixels allowed before the variant fails. Pixel-perfect means 0. */
	readonly tolerance?: number
	/** Fail the variant on ARIA snapshot differences too (`--strict-a11y`). */
	readonly strictA11y?: boolean
	/** Skip app-root background calls (lab pages, see `diffCallLogs`). */
	readonly ignoreBackgroundCalls?: boolean
	/** Tag prefixes left out of the behavior diff (`Scenario.pageCalls`). */
	readonly ignoreCalls?: ReadonlyArray<string>
}): VariantComparison => {
	const { variantId } = options
	const baselinePng = join(options.baselineDir, `${variantId}.png`)
	const candidatePng = join(options.candidateDir, `${variantId}.png`)
	if (!existsSync(baselinePng) || !existsSync(candidatePng)) {
		return {
			variantId,
			status: "missing",
			visualStatus: "missing",
			width: 0,
			height: 0,
			sizeMismatch: false,
			strictPixels: 0,
			perceptualPixels: 0,
			mismatchPercent: 100,
			regions: [],
			deltas: [],
			missingInCandidate: [],
			extraInCandidate: [],
			behavior: [],
			a11y: { missing: [], extra: [] },
		}
	}

	const a = readPng(baselinePng)
	const b = readPng(candidatePng)
	const width = Math.max(a.width, b.width)
	const height = Math.max(a.height, b.height)
	const aData = padTo(a, width, height)
	const bData = padTo(b, width, height)
	const diff = new PNG({ width, height })
	const strictPixels = countStrict(aData, bData)
	const perceptualPixels = pixelmatch(aData, bData, diff.data, width, height, {
		threshold: 0.1,
		includeAA: false,
		alpha: 0.15,
		diffColor: [255, 0, 0],
		diffColorAlt: [0, 200, 0],
	})
	const diffImage = `${variantId}.diff.png`
	writeFileSync(join(options.outDir, diffImage), PNG.sync.write(diff))

	const readSnapshot = (dir: string): CaptureSnapshot | undefined => {
		const path = join(dir, `${variantId}.json`)
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
	}
	const baseSnap = readSnapshot(options.baselineDir)
	const candSnap = readSnapshot(options.candidateDir)
	const structural =
		baseSnap && candSnap
			? diffSnapshots(baseSnap, candSnap)
			: { deltas: [], missingInCandidate: [], extraInCandidate: [] }

	const regions: Region[] = findRegions(diff.data, width, height)
		.slice(0, 20)
		.map((region) => ({
			...region,
			nodes: [
				...structural.deltas
					.filter(
						(delta) =>
							overlaps(region, delta.rect.baseline) || overlaps(region, delta.rect.candidate),
					)
					.map((delta) => delta.key),
				...structural.missingInCandidate
					.filter((node) => overlaps(region, node.rect))
					.map((node) => `missing ${node.key}`),
				...structural.extraInCandidate
					.filter((node) => overlaps(region, node.rect))
					.map((node) => `extra ${node.key}`),
			].slice(0, 12),
		}))

	const behavior = diffCallLogs(baseSnap?.calls ?? [], candSnap?.calls ?? [], {
		ignoreBackground: options.ignoreBackgroundCalls,
		ignore: options.ignoreCalls,
	})
	const a11y = diffAria(baseSnap?.aria ?? "", candSnap?.aria ?? "")
	const a11yFails = options.strictA11y && (a11y.missing.length > 0 || a11y.extra.length > 0)

	const tolerance = options.tolerance ?? 0
	const pixelStatus =
		strictPixels === 0
			? "identical"
			: perceptualPixels <= tolerance && a.width === b.width && a.height === b.height
				? "pass"
				: "fail"
	return {
		variantId,
		status: behavior.length || a11yFails ? "fail" : pixelStatus,
		visualStatus: pixelStatus,
		width,
		height,
		sizeMismatch: a.width !== b.width || a.height !== b.height,
		strictPixels,
		perceptualPixels,
		mismatchPercent: Math.round((perceptualPixels / (width * height)) * 100_000) / 1000,
		regions,
		...structural,
		behavior,
		a11y,
		diffImage,
	}
}
