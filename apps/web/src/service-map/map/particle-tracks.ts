// copied: packages/ui/src/components/service-map/service-map-particles.tsx (the budget and
// sampling half), which cannot be imported here because it is a React module.

export const MAX_TOTAL_PARTICLES = 400
const TRAVERSE_TIME = 2
const MAX_DUR = 20
const MAX_PARTICLES_PER_EDGE = 8

export interface EdgeParticleSpec {
	readonly id: string
	readonly path: string
	readonly sourceColor: string
	readonly callsPerSecond: number
	readonly strokeWidth: number
}

const desiredParticles = (callsPerSecond: number): number => {
	const rate = Math.max(0, callsPerSecond)
	if (rate <= 0) return 0
	if (1 / rate > TRAVERSE_TIME) return 1
	return Math.min(MAX_PARTICLES_PER_EDGE, Math.max(1, Math.round(rate * TRAVERSE_TIME)))
}

const traversalDuration = (callsPerSecond: number): number => {
	const rate = Math.max(0, callsPerSecond)
	if (rate <= 0) return TRAVERSE_TIME
	const interArrival = 1 / rate
	return interArrival > TRAVERSE_TIME ? Math.min(interArrival, MAX_DUR) : TRAVERSE_TIME
}

/** Global particle budget by call rate, largest-remainder rounding. */
export const allocateParticleBudget = (
	specs: ReadonlyArray<EdgeParticleSpec>,
	maxTotal = MAX_TOTAL_PARTICLES,
) => {
	const desired = specs.map((spec) => [spec.id, desiredParticles(spec.callsPerSecond)] as const)
	const totalDesired = desired.reduce((sum, [, d]) => sum + d, 0)
	const result = new Map<string, number>()
	if (totalDesired <= maxTotal || totalDesired === 0) {
		for (const [id, d] of desired) result.set(id, d)
		return result
	}
	const scale = maxTotal / totalDesired
	const remainders: Array<[string, number]> = []
	let used = 0
	for (const [id, d] of desired) {
		if (d === 0) {
			result.set(id, 0)
			continue
		}
		const ideal = d * scale
		const floor = Math.floor(ideal)
		result.set(id, floor)
		used += floor
		remainders.push([id, ideal - floor])
	}
	remainders.sort((a, b) => b[1] - a[1])
	let remaining = maxTotal - used
	for (let i = 0; i < remainders.length && remaining > 0; i++) {
		result.set(remainders[i][0], (result.get(remainders[i][0]) ?? 0) + 1)
		remaining--
	}
	return result
}

export interface Track {
	readonly points: Float32Array
	readonly segments: number
	readonly minX: number
	readonly minY: number
	readonly maxX: number
	readonly maxY: number
	readonly count: number
	readonly duration: number
	readonly phase: number
	readonly radius: number
	readonly sourceColor: string
}

const hash01 = (value: string): number => {
	let h = 0
	for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0
	return (Math.abs(h) % 1000) / 1000
}

type Sampled = Pick<Track, "points" | "segments" | "minX" | "minY" | "maxX" | "maxY">

/** Equal-distance samples along one SVG path, measured with a detached `<path>`. */
const samplePath = (d: string): Sampled | null => {
	const element = document.createElementNS("http://www.w3.org/2000/svg", "path")
	element.setAttribute("d", d)
	const length = element.getTotalLength()
	if (!(length > 0)) return null
	const segments = Math.min(64, Math.max(16, Math.ceil(length / 24)))
	const points = new Float32Array((segments + 1) * 2)
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY
	for (let index = 0; index <= segments; index++) {
		const point = element.getPointAtLength((index / segments) * length)
		points[index * 2] = point.x
		points[index * 2 + 1] = point.y
		minX = Math.min(minX, point.x)
		minY = Math.min(minY, point.y)
		maxX = Math.max(maxX, point.x)
		maxY = Math.max(maxY, point.y)
	}
	return { points, segments, minX, minY, maxX, maxY }
}

/** Samples by path string, so a drag re-samples only the edges whose geometry moved. */
export type PathCache = Map<string, Sampled | null>

export const compileTracks = (
	specs: ReadonlyArray<EdgeParticleSpec>,
	cache: PathCache = new Map(),
): ReadonlyArray<Track> => {
	const budget = allocateParticleBudget(specs)
	const livePaths = new Set<string>()
	const tracks = specs.flatMap((spec) => {
		livePaths.add(spec.path)
		const count = budget.get(spec.id) ?? 0
		if (count <= 0 || !spec.path) return []
		if (!cache.has(spec.path)) cache.set(spec.path, samplePath(spec.path))
		const sampled = cache.get(spec.path)
		if (sampled === null || sampled === undefined) return []
		return [
			{
				...sampled,
				count,
				duration: traversalDuration(spec.callsPerSecond),
				phase: hash01(spec.id),
				radius: Math.max(1.5, spec.strokeWidth * 0.5),
				sourceColor: spec.sourceColor,
			},
		]
	})
	// Layouts and drags keep minting paths; keep only the ones still on the map.
	for (const path of cache.keys()) if (!livePaths.has(path)) cache.delete(path)
	return tracks
}
