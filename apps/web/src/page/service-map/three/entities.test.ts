import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { entityLayer, type EntitySpec } from "./entities"
import type { Scope } from "./kit"

/** A belt-like build: a mesh painted with the layer's one "parcel" texture, made on first use. */
const belt = (id: string, made: Array<THREE.Texture>): EntitySpec => ({
	id,
	key: id,
	build: (scope: Scope) => {
		const cached = scope.textures.get("parcel")
		const texture = cached ?? new THREE.Texture()
		if (cached === undefined) {
			scope.textures.set("parcel", texture)
			made.push(texture)
		}
		return new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture }))
	},
})

describe("entityLayer textures", () => {
	it("belts share one painted texture, removing a belt keeps it, disposing the layer frees it", () => {
		const made: Array<THREE.Texture> = []
		const freed: Array<string> = []
		const layer = entityLayer()
		layer.sync([belt("a", made), belt("b", made), belt("c", made)])
		expect(made).toHaveLength(1)
		made[0]?.addEventListener("dispose", () => freed.push("parcel"))
		layer.sync([belt("a", made)])
		expect(freed).toEqual([])
		layer.dispose()
		expect(freed).toEqual(["parcel"])
	})
})
