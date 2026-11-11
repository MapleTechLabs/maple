import { Array as Arr, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { SERVICE_MAP_3D_TOPOLOGY } from "../../../lab/service-map-3d/fixture"
import type { Node3D, Topology3D } from "../three/types"
import { linksOf, targetsFor } from "./board"
import {
	heldIdOf,
	init,
	litClockOf,
	Message,
	type Model,
	OutMessage,
	placementsOf,
	sync,
	update,
} from "./update"

const topology = SERVICE_MAP_3D_TOPOLOGY
const links = linksOf(topology)

/** Half past ten on a March morning, north of the equator. */
const clock = { hour: 10.5, day: 80, isSouthern: false }
const start = (): Model => ({ ...sync(init(), topology), clock })
/** The clock a model is lit for. */
const lit = (model: Model) => litClockOf(model, model.clock ?? clock)
const step = (model: Model, message: Message, on: Topology3D = topology): Model =>
	update(model, message, on).model
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

	it("hands a picked service to the parent, and clears it on Rearrange", () => {
		const id = topology.nodes[0]?.id ?? null
		expect(update(start(), Message.PickedNode({ nodeId: id }), topology).outMessage).toEqual(
			OutMessage.Selected({ nodeId: id }),
		)
		expect(update(start(), Message.ClickedRearrange(), topology).outMessage).toEqual(
			OutMessage.Selected({ nodeId: null }),
		)
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

describe("the light on the map", () => {
	it("follows the viewer's clock until a time of day is picked", () => {
		expect(lit(start())).toEqual(clock)
		const later = step(start(), Message.TickedClock({ clock: { ...clock, hour: 19.25 } }))
		expect(lit(later).hour).toBe(19.25)
	})

	it("steps through dawn, day, dusk and night and back to the clock", () => {
		const modes = Arr.map(
			Arr.scan(Arr.range(1, 5), start(), (model) => step(model, Message.ClickedLight())),
			(model) => model.light,
		)
		expect(modes).toEqual(["clock", "dawn", "day", "dusk", "night", "clock"])
	})

	it("holds a picked time of day whatever the clock says", () => {
		const night = Arr.reduce(Arr.range(1, 4), start(), (model) => step(model, Message.ClickedLight()))
		const ticked = step(night, Message.TickedClock({ clock: { ...clock, hour: 13 } }))
		expect(ticked.light).toBe("night")
		expect(lit(ticked).hour).toBe(lit(night).hour)
		// The season still comes from the clock: only the hour is held.
		expect(lit(ticked).day).toBe(clock.day)
	})
})

describe("the board over a live map", () => {
	const [kept, gone] = [topology.nodes[0], topology.nodes[1]]
	const newcomer: Node3D = {
		id: "newcomer",
		label: "newcomer",
		kind: "service",
		namespace: kept?.namespace ?? "services",
		platform: "unknown",
		throughput: 3,
		errorRate: 0,
	}
	const changed: Topology3D = {
		nodes: [...Arr.filter(topology.nodes, (node) => node.id !== gone?.id), newcomer],
		edges: [
			...Arr.filter(topology.edges, (edge) => edge.source !== gone?.id && edge.target !== gone?.id),
			{
				source: newcomer.id,
				target: kept?.id ?? "",
				callsPerSecond: 3,
				errorRate: 0,
				avgLatencyMs: 12,
			},
		],
	}

	it("keeps every tile still on the map where it stood, places a newcomer and drops the gone", () => {
		const before = start()
		const after = sync(before, changed)
		const stayed = Arr.filter(changed.nodes, (node) => node.id !== newcomer.id)
		expect(Arr.map(stayed, (node) => after.cells[node.id])).toEqual(
			Arr.map(stayed, (node) => before.cells[node.id]),
		)
		expect(after.cells[newcomer.id]).toBeDefined()
		expect(after.cells[gone?.id ?? ""]).toBeUndefined()
		expect(Rec.keys(after.cells)).toHaveLength(changed.nodes.length)
	})

	it("returns the same board while the services stay the same", () => {
		const model = start()
		expect(sync(model, { ...topology, edges: [] })).toBe(model)
	})

	it("adds a newcomer to the stack during a deal instead of placing it", () => {
		const dealt = step(start(), Message.ClickedDeal())
		const after = sync(dealt, changed)
		expect(after.cells[newcomer.id]).toBeUndefined()
		expect(after.stack).toContain(newcomer.id)
		expect(after.stack).not.toContain(gone?.id)
	})

	it("lays the board out for the map a message arrives with", () => {
		const moved = step(start(), Message.ClickedSound(), changed)
		expect(Rec.keys(moved.cells)).toHaveLength(changed.nodes.length)
	})
})
