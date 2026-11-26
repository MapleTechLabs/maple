import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { describe, expect, it } from "vitest"
import { init, kubernetesMethod, Message, type Model, update } from "./install-modal"

const press = (model: Model, value: string, index: number): Model =>
	update(model, Message.GotMethodMessage({ message: ToggleGroup.Message.ClickedItem({ value, index }) }))
		.model

describe("install modal Kubernetes method", () => {
	it("starts on Helm and switches to the method pressed", () => {
		const model = init("install", "kubernetes")
		expect(kubernetesMethod(model)).toBe("helm")
		expect(kubernetesMethod(press(model, "alchemy", 1))).toBe("alchemy")
		expect(kubernetesMethod(press(press(model, "alchemy", 1), "terraform", 2))).toBe("terraform")
	})

	it("keeps a method selected when the selected one is pressed again", () => {
		const alchemy = press(init("install", "kubernetes"), "alchemy", 1)
		expect(kubernetesMethod(press(alchemy, "alchemy", 1))).toBe("alchemy")
	})
})
