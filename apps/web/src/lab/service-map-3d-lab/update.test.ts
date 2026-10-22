import { describe, expect, test } from "vitest"
import * as Scene3d from "../../page/service-map/scene3d"
import { init, Message, update } from "./update"

const opened = () => init({ reducedMotion: false }).model

describe("service map 3D lab", () => {
	test("a pick in the scene selects the node, and empty paper clears it", () => {
		const picked = update(
			opened(),
			Message.GotSceneMessage({ message: Scene3d.Message.PickedNode({ nodeId: "checkout" }) }),
		)
		expect(picked.model.selectedId).toBe("checkout")
		const cleared = update(
			picked.model,
			Message.GotSceneMessage({ message: Scene3d.Message.PickedNode({ nodeId: null }) }),
		)
		expect(cleared.model.selectedId).toBeNull()
	})
})
