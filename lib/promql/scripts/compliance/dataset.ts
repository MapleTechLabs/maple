import type { RawSeries } from "../../src/engine/index"

/** Deterministic PRNG so every run compares the same data. */
const mulberry32 = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0
	let t = seed
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const DATA_START_MS = 1_700_000_000_000
export const SCRAPE_MS = 15_000
export const DATA_END_MS = DATA_START_MS + 3 * 3600_000

const times = (from = DATA_START_MS, to = DATA_END_MS, every = SCRAPE_MS): number[] => {
	const out: number[] = []
	for (let t = from; t <= to; t += every) out.push(t)
	return out
}

export const buildDataset = (): RawSeries[] => {
	const rand = mulberry32(42)
	const series: RawSeries[] = []

	// Counters: steady, bursty, one reset, one starting late, one with a gap, one sparse.
	const counter = (
		labels: Record<string, string>,
		opts: { reset?: number; from?: number; gap?: [number, number]; every?: number },
	) => {
		let value = Math.floor(rand() * 1000)
		const samples: Array<readonly [number, number]> = []
		for (const t of times(opts.from, DATA_END_MS, opts.every)) {
			if (opts.gap && t > opts.gap[0] && t < opts.gap[1]) continue
			value += Math.floor(rand() * 20)
			if (opts.reset !== undefined && t === opts.reset) value = Math.floor(rand() * 5)
			samples.push([t, value])
		}
		series.push({ labels: { __name__: "http_requests_total", job: "api", ...labels }, samples })
	}
	counter({ instance: "a:9090", code: "200" }, {})
	counter({ instance: "a:9090", code: "500" }, { reset: DATA_START_MS + 3600_000 })
	counter({ instance: "b:9090", code: "200" }, { from: DATA_START_MS + 4500_000 })
	counter(
		{ instance: "b:9090", code: "500" },
		{ gap: [DATA_START_MS + 1800_000, DATA_START_MS + 2700_000] },
	)
	counter({ instance: "c:9090", code: "200" }, { every: 60_000 })

	// Gauges: random walks, one with NaN-free negative values.
	for (const instance of ["a:9100", "b:9100", "c:9100"]) {
		let value = 1e9 * (1 + rand())
		series.push({
			labels: { __name__: "node_memory_free_bytes", job: "node", instance },
			samples: times().map((t) => {
				value += (rand() - 0.5) * 5e7
				return [t, Math.round(value)] as const
			}),
		})
	}
	let temp = 0
	series.push({
		labels: { __name__: "room_temperature_celsius", job: "sensor", room: "lab" },
		samples: times().map((t) => {
			temp += (rand() - 0.5) * 2
			return [t, Math.round(temp * 100) / 100] as const
		}),
	})

	// A classic histogram, two services.
	const bounds = ["0.1", "0.5", "1", "+Inf"]
	for (const service of ["checkout", "search"]) {
		const counts = [0, 0, 0, 0]
		let sum = 0
		const bucketSamples: Array<Array<readonly [number, number]>> = bounds.map(() => [])
		const countSamples: Array<readonly [number, number]> = []
		const sumSamples: Array<readonly [number, number]> = []
		for (const t of times()) {
			const observations = Math.floor(rand() * 30)
			for (let i = 0; i < observations; i++) {
				const latency = rand() ** 2 * 1.5
				sum += latency
				bounds.forEach((le, index) => {
					if (le === "+Inf" || latency <= Number(le)) counts[index] = (counts[index] ?? 0) + 1
				})
			}
			bounds.forEach((_le, index) => bucketSamples[index]?.push([t, counts[index] ?? 0]))
			countSamples.push([t, counts[3] ?? 0])
			sumSamples.push([t, Math.round(sum * 1000) / 1000])
		}
		const base = { job: "web", service }
		bounds.forEach((le, index) => {
			series.push({
				labels: { __name__: "http_request_duration_seconds_bucket", ...base, le },
				samples: bucketSamples[index] ?? [],
			})
		})
		series.push({
			labels: { __name__: "http_request_duration_seconds_count", ...base },
			samples: countSamples,
		})
		series.push({
			labels: { __name__: "http_request_duration_seconds_sum", ...base },
			samples: sumSamples,
		})
	}
	return series
}

const escape = (value: string): string =>
	value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

/** OpenMetrics text for `promtool tsdb create-blocks-from openmetrics`. */
export const toOpenMetrics = (series: ReadonlyArray<RawSeries>): string => {
	const byName = new Map<string, RawSeries[]>()
	for (const s of series) {
		const name = s.labels.__name__ ?? ""
		byName.set(name, [...(byName.get(name) ?? []), s])
	}
	const lines: string[] = []
	for (const [name, group] of byName) {
		lines.push(`# TYPE ${name} unknown`)
		for (const s of group) {
			const labels = Object.entries(s.labels)
				.filter(([k]) => k !== "__name__")
				.map(([k, v]) => `${k}="${escape(v)}"`)
				.join(",")
			for (const [t, v] of s.samples) lines.push(`${name}{${labels}} ${v} ${t / 1000}`)
		}
	}
	lines.push("# EOF")
	return `${lines.join("\n")}\n`
}
