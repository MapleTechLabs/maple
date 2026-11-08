import { Array as Arr, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WorldConflictError, WorldDocument } from "./service-map-world"

const building = {
	id: "svc:api",
	entity: { _tag: "ServiceBuilding", nodeId: "api", cell: { x: 1, z: 2 }, rotation: 0, building: "tank" },
	revision: 2,
	updatedAt: "2026-11-07T12:00:00.000Z",
	updatedBy: null,
}
const decoration = { ...building, id: "dec:tree", entity: { _tag: "Decoration", sprite: "tree" } }

describe("world records on the wire", () => {
	it("an entity kind this build does not know is skipped, the rest of the world still loads", () => {
		const doc = Schema.decodeSync(WorldDocument)({
			schemaVersion: 2,
			entities: [decoration, building],
		})
		expect(Arr.map(doc.entities, (record) => record.id)).toEqual(["svc:api"])
	})

	it("a conflict carrying an unknown kind still decodes", () => {
		const error = Schema.decodeSync(WorldConflictError)({
			_tag: "@maple/http/service-map-world/WorldConflictError",
			message: "changed",
			ids: ["svc:api", "dec:tree"],
			current: [building, decoration],
		})
		expect(Arr.map(error.current, (record) => record.revision)).toEqual([2])
	})

	it("encodes back to plain records", () => {
		const doc = Schema.decodeSync(WorldDocument)({ schemaVersion: 1, entities: [building] })
		expect(Schema.encodeSync(WorldDocument)(doc)).toEqual({ schemaVersion: 1, entities: [building] })
	})
})
