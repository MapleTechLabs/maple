/** Seeded mulberry32. Ids come from it too, so a re-seed reproduces the same traces. */
export class Rng {
	private state: number

	constructor(seed: number) {
		this.state = seed >>> 0
	}

	next(): number {
		this.state = (this.state + 0x6d2b79f5) | 0
		let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1))
	}

	chance(p: number): boolean {
		return this.next() < p
	}

	pick<T>(items: readonly [T, ...T[]]): T {
		return items[Math.floor(this.next() * items.length)] ?? items[0]
	}

	weighted<T>(items: readonly [readonly [T, number], ...(readonly [T, number])[]]): T {
		const total = items.reduce((sum, [, weight]) => sum + weight, 0)
		let roll = this.next() * total
		for (const [item, weight] of items) {
			roll -= weight
			if (roll <= 0) return item
		}
		return items[0][0]
	}

	gaussian(): number {
		const u = Math.max(this.next(), Number.EPSILON)
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next())
	}

	/** Log-normal latency: `median` ms, `spread` ≈ 0.3 tight, 0.8 long-tailed. */
	latency(median: number, spread: number): number {
		return Math.max(0.2, median * Math.exp(spread * this.gaussian()))
	}

	hex(bytes: number): string {
		let out = ""
		for (let i = 0; i < bytes; i++) out += this.int(0, 255).toString(16).padStart(2, "0")
		return out
	}
}
