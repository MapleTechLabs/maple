import { Array as Arr, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { targetsFor } from "./board"
import { heldIdOf, init, links, Message, type Model, placementsOf, topology, update } from "./update"

const start = (): Model => init({ reducedMotion: false }).model
const step = (model: Model, message: Message): Model => update(model, message).model
const firstFree = (model: Model, id: string) => targetsFor(placementsOf(model), id).free[0] ?? { q: 0, r: 0 }

describe("the tile board", () => {
	it("opens with every service on the board and nothing in hand", () => {
		const model = start()
		expect(Rec.keys(model.cells)).toHaveLength(topology.nodes.length)
		expect(heldIdOf(model)).toBeNull()
	})

	it("deals one tile onto the middle and holds the next", () => {
		const model = step(start(), Message.ClickedDeal())
		expect(Rec.values(model.cells)).toEqual([{ q: 0, r: 0 }])
		expect(model.stack).toHaveLength(topology.nodes.length - 1)
		expect(heldIdOf(model)).toBe(model.stack[0])
	})

	it("puts the held tile down and draws the next one", () => {
		const dealt = step(start(), Message.ClickedDeal())
		const held = heldIdOf(dealt) ?? ""
		const cell = firstFree(dealt, held)
		const placed = step(dealt, Message.PlacedTile({ nodeId: held, cell }))
		expect(placed.cells[held]).toEqual(cell)
		expect(placed.stack).toEqual(Arr.drop(dealt.stack, 1))
		expect(heldIdOf(placed)).toBe(dealt.stack[1])
	})

	it("ignores a drop on a cell away from every tile, and a tile that is not in hand", () => {
		const dealt = step(start(), Message.ClickedDeal())
		const held = heldIdOf(dealt) ?? ""
		expect(step(dealt, Message.PlacedTile({ nodeId: held, cell: { q: 7, r: 7 } }))).toEqual(dealt)
		const other = dealt.stack[3] ?? ""
		expect(step(dealt, Message.PlacedTile({ nodeId: other, cell: firstFree(dealt, other) }))).toEqual(
			dealt,
		)
	})

	it("keeps the stack's top in hand on Escape and cannot leave the deal by Rearrange", () => {
		const dealt = step(start(), Message.ClickedDeal())
		expect(heldIdOf(step(dealt, Message.CancelledHold()))).toBe(dealt.stack[0])
		expect(step(dealt, Message.ClickedRearrange())).toEqual(dealt)
	})

	it("lays the rest of the stack out around the tiles already down", () => {
		const dealt = step(start(), Message.ClickedDeal())
		const held = heldIdOf(dealt) ?? ""
		const placed = step(dealt, Message.PlacedTile({ nodeId: held, cell: { q: -1, r: 0 } }))
		const finished = step(placed, Message.ClickedPlaceRest())
		expect(finished.stack).toEqual([])
		expect(Rec.keys(finished.cells)).toHaveLength(topology.nodes.length)
		expect(finished.cells[held]).toEqual({ q: -1, r: 0 })
	})

	it("lifts a tile only while rearranging, and trades it with the tile it is put on", () => {
		const model = start()
		const [a, b] = [topology.nodes[0]?.id ?? "", topology.nodes[1]?.id ?? ""]
		expect(heldIdOf(step(model, Message.PickedUpTile({ nodeId: a })))).toBeNull()
		const lifted = step(step(model, Message.ClickedRearrange()), Message.PickedUpTile({ nodeId: a }))
		expect(heldIdOf(lifted)).toBe(a)
		const traded = step(lifted, Message.PlacedTile({ nodeId: a, cell: model.cells[b] ?? { q: 0, r: 0 } }))
		expect([traded.cells[a], traded.cells[b]]).toEqual([model.cells[b], model.cells[a]])
		expect(heldIdOf(traded)).toBeNull()
	})

	it("shows the connection of a poked cart or train until a service is picked", () => {
		const linkId = links[0]?.id ?? ""
		const poked = step(start(), Message.PokedLink({ linkId }))
		expect(poked.pokedLinkId).toBe(linkId)
		expect(
			step(poked, Message.PickedNode({ nodeId: topology.nodes[0]?.id ?? null })).pokedLinkId,
		).toBeNull()
		expect(step(poked, Message.ClosedLinkCard()).pokedLinkId).toBeNull()
		expect(step(poked, Message.ClickedRearrange()).pokedLinkId).toBeNull()
	})

	it("ignores a poke for a link that is not on the map", () => {
		expect(step(start(), Message.PokedLink({ linkId: "nowhere" }))).toEqual(start())
	})

	it("puts a lifted tile back on Escape", () => {
		const a = topology.nodes[0]?.id ?? ""
		const lifted = step(step(start(), Message.ClickedRearrange()), Message.PickedUpTile({ nodeId: a }))
		const back = step(lifted, Message.CancelledHold())
		expect(heldIdOf(back)).toBeNull()
		expect(back.cells).toEqual(start().cells)
	})
})
