import { Array as Arr } from "effect"
import * as THREE from "three"
import type { Biome } from "./biome"
import type { TilePalette } from "./palette"
import { creases, fuse, moved, part, pickFrom, seeded, vary } from "./solid"
import { boulder, earthBlock, field, patch, scatter, tree } from "./tile"
import { barn, cottage, placed } from "./village"

// The open country between and around the services: tiles nobody lives on. Each takes the biome
// of the service nearest to it, so a namespace's country runs on past its last village.

export type Feature = "forest" | "meadow" | "hills" | "mountain" | "farm"

export interface WildSpec {
	/** The cell's key: the same cell is always the same country. */
	readonly key: string
	readonly biome: Biome
	readonly feature: Feature
	readonly palette: TilePalette
}

export interface WildTile {
	readonly geometry: THREE.BufferGeometry
	readonly ink: THREE.BufferGeometry
}

/** What a cell of open country is. Mountains only stand where no tile can be put (`ring` 2): a
 * cell beside a tile is foothills instead, so a place to build is never hidden under a peak. */
export const featureOf = (key: string, ring: 1 | 2, biome: Biome): Feature => {
	const roll = seeded(`feature:${key}`)()
	// Rocky and snowy country runs to mountains; wooded country to forest.
	const peaks = biome.boulders > 1 ? 0.34 : 0.14
	const woods = 0.2 + Math.min(0.3, biome.woodland * 0.12)
	const feature: Feature =
		roll < peaks
			? "mountain"
			: roll < peaks + woods
				? "forest"
				: roll < peaks + woods + 0.16
					? "hills"
					: roll < peaks + woods + 0.16 + (biome.fieldCount > 2 ? 0.26 : 0.1)
						? "farm"
						: "meadow"
	return feature === "mountain" && ring === 1 ? "hills" : feature
}

type Parts = ReadonlyArray<THREE.BufferGeometry>

/** A grassy mound standing on y = 0. */
const mound = (random: () => number, color: THREE.Color): THREE.BufferGeometry => {
	const radius = 0.7 + random() * 0.6
	return part(new THREE.SphereGeometry(radius, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2), color, {
		turn: random() * Math.PI,
		scale: [1, 0.38 + random() * 0.2, 1],
	})
}

/** A peak standing on y = 0: a six-sided cone of rock under a cap of snow. */
const peak = (palette: TilePalette, random: () => number): Parts => {
	const radius = 0.95 + random() * 0.55
	const height = 1.5 + random() * 1.1
	const cap = 0.36
	return [
		part(new THREE.ConeGeometry(radius, height, 6), vary(palette.rock, random, 0.05), {
			position: [0, height / 2, 0],
			turn: random() * Math.PI,
		}),
		part(new THREE.ConeGeometry(radius * cap * 1.04, height * cap, 6), palette.snow, {
			position: [0, height * (1 - cap / 2) + 0.01, 0],
			turn: random() * Math.PI,
		}),
	]
}

export const buildWild = ({ key, biome, feature, palette }: WildSpec): WildTile => {
	const random = seeded(`wild:${key}`)
	const taken: Array<readonly [number, number]> = []
	const ground = vary(pickFrom(biome.grounds, random, biome.turf), random, 0.01)
	const on = (parts: Parts, at: readonly [number, number]): Parts =>
		moved(parts, { position: [at[0], 0, at[1]] })
	const trees = (count: number, near: number, far: number): Parts =>
		Arr.flatMap(scatter(random, count, 0.44, near, far, taken), (spot) =>
			on(tree(palette, biome, random), spot.at),
		)
	const rocks = (count: number): Parts =>
		Arr.flatMap(scatter(random, count, 0.5, 0.3, 0.86, taken), (spot) =>
			on(boulder(palette, random), spot.at),
		)
	const flat: Array<THREE.BufferGeometry> = []
	const raised: Array<THREE.BufferGeometry> = []
	if (feature === "forest") {
		raised.push(...rocks(2), ...trees(Math.round(36 + biome.woodland * 14), 0.1, 0.9))
	} else if (feature === "hills") {
		const mounds = Arr.flatMap(scatter(random, 4, 1.3, 0.2, 0.62, taken), (spot) =>
			on([mound(random, ground.clone().offsetHSL(0, 0, -0.03))], spot.at),
		)
		raised.push(...mounds, ...rocks(3), ...trees(Math.round(6 + biome.woodland * 4), 0.4, 0.9))
	} else if (feature === "mountain") {
		const peaks = Arr.flatMap(scatter(random, 3, 1.25, 0, 0.5, taken), (spot) =>
			on(peak(palette, random), spot.at),
		)
		raised.push(...peaks, ...rocks(6), ...trees(Math.round(5 + biome.woodland * 3), 1.7, 0.92))
	} else if (feature === "farm") {
		const strips = Arr.map(scatter(random, 7, 1.35, 0.9, 0.74, taken), (spot) =>
			field(biome, random)
				.rotateY(random() * Math.PI)
				.translate(spot.at[0], 0, spot.at[1]),
		)
		const yard = [
			placed(barn(palette, biome, random), { position: [0.2, 0, -0.1], turn: random() * Math.PI }),
			placed(cottage(palette, biome, random), { position: [-0.45, 0, 0.3], turn: random() * Math.PI }),
		]
		taken.push([0, 0])
		flat.push(
			patch(random, 0.9, 0.005, biome.yard),
			...strips,
			...Arr.flatMap(yard, (built) => built.trim),
		)
		raised.push(...Arr.flatMap(yard, (built) => built.solid), ...trees(6, 1.2, 0.9))
	} else {
		// A meadow: a few trees, a few rocks and drifts of flowers.
		const flowers = Arr.map(scatter(random, 9, 0.5, 0.2, 0.85, taken), (spot) =>
			patch(
				random,
				0.1 + random() * 0.08,
				0.012,
				pickFrom(palette.awnings, random, palette.snow),
			).translate(spot.at[0], 0, spot.at[1]),
		)
		flat.push(...flowers)
		raised.push(...rocks(2), ...trees(Math.round(5 + biome.woodland * 4), 0.3, 0.9))
	}
	const inked = fuse(raised)
	return {
		geometry: fuse([earthBlock(palette, biome.turf, ground.getStyle()), ...flat, inked]),
		ink: creases(inked),
	}
}
