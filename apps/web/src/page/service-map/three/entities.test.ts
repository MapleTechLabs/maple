import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { entityLayer, type EntitySpec } from "./entities"
import type { Scope } from "./kit"

/** A belt-like build: a mesh painted with the layer's one "parcel" texture, made on first use. */
const belt = (id: string, made: Array<THREE.Texture>): EntitySpec => ({
	id,
	key: id,
	build: (scope: Scope) => {
		const cached = scope.shared.get("parcel")
		const texture = cached ?? new THREE.Texture()
		if (cached === undefined) {
			scope.shared.set("parcel", texture)
			made.push(texture)
		}
		return new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture }))
	},
})

/** A build that owns one route texture, as a belt's motion data does. */
const routed = (id: string, routes: Array<THREE.Texture>): EntitySpec => ({
	id,
	key: id,
	build: (scope: Scope) => {
		const route = new THREE.Texture()
		scope.textures.set(`route:${id}`, route)
		routes.push(route)
		return new THREE.Group()
	},
})

describe("entityLayer textures", () => {
	it("a build's own textures are freed with it, so rebuilding belts never piles them up", () => {
		const routes: Array<THREE.Texture> = []
		const freed: Array<number> = []
		const layer = entityLayer()
		layer.sync([routed("a", routes)])
		routes[0]?.addEventListener("dispose", () => freed.push(0))
		layer.sync([{ ...routed("a", routes), key: "a@2" }])
		expect(freed).toEqual([0])
		layer.dispose()
	})

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
