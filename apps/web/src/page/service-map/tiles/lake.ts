import { Array as Arr } from "effect"
import * as THREE from "three"
import { HEX_SIZE } from "./hex"
import type { TilePalette } from "./palette"
import { creases, fuse, part, seeded, vary } from "./solid"
import { earthBlock, patch } from "./tile"

// Water spawns on its own where the land closes in on a free cell (`lakesOf`). A lake is a tile
// like any other, cut from the same block of earth, and the first one is home to the ducks.

const INRADIUS = HEX_SIZE * Math.cos(Math.PI / 6)

/** How far from a lake's middle the ducks paddle their loop. */
export const DUCK_LOOP = INRADIUS * 0.42

export interface Lake {
	readonly geometry: THREE.BufferGeometry
	readonly ink: THREE.BufferGeometry
}

/** A lake tile: a sandy shore round the water, reeds and a few rocks on the bank, lily pads afloat. */
export const buildLake = (id: string, palette: TilePalette): Lake => {
	const random = seeded(`lake:${id}`)
	const around = (count: number, near: number, far: number) =>
		Arr.makeBy(count, () => {
			const angle = random() * Math.PI * 2
			const distance = INRADIUS * (near + random() * (far - near))
			return [Math.cos(angle) * distance, Math.sin(angle) * distance] as const
		})
	const reeds = Arr.flatMap(around(9, 0.74, 0.86), ([x, z]) =>
		Arr.makeBy(3, (index) => {
			const height = 0.22 + random() * 0.2
			return part(new THREE.BoxGeometry(0.025, height, 0.025), vary(palette.reed, random, 0.05), {
				position: [x + (index - 1) * 0.06, height / 2, z + (random() - 0.5) * 0.08],
			})
		}),
	)
	const rocks = Arr.map(around(4, 0.8, 0.9), ([x, z]) => {
		const size = 0.12 + random() * 0.12
		return part(new THREE.IcosahedronGeometry(size, 0), vary(palette.rock, random, 0.05), {
			position: [x, size * 0.4, z],
			turn: random() * Math.PI,
			scale: [1, 0.7, 1.2],
		})
	})
	const pads = Arr.map(around(7, 0.12, 0.6), ([x, z]) =>
		patch(random, 0.09 + random() * 0.05, 0.03, palette.lily).translate(x, 0, z),
	)
	const inked = fuse([patch(random, INRADIUS * 0.76, 0.014, palette.water), ...reeds, ...rocks])
	const ink = creases(inked)
	return {
		geometry: fuse([
			earthBlock(palette, palette.bank, palette.bank),
			patch(random, INRADIUS * 0.86, 0.007, palette.sand),
			inked,
			patch(random, INRADIUS * 0.44, 0.02, palette.waterDeep),
			...pads,
		]),
		ink,
	}
}
