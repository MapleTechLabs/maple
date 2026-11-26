import * as Dialog from "@maple/views/ui/dialog"
import { describe, expect, it } from "vitest"
import * as Recipe from "../../kit/install-recipe"
import { init, Message, type Model, update } from "./install-modal"
import { KUBERNETES_RECIPES } from "./install-snippets"

const send = (model: Model, message: Message): Model => update(model, message).model
const recipe = (model: Model, message: Recipe.Message): Model =>
	send(model, Message.GotRecipeMessage({ message }))

describe("install modal", () => {
	it("starts Kubernetes on Helm and switches to the tool picked", () => {
		const model = init("install", "kubernetes")
		expect(Recipe.selectedRecipe(model.recipe, KUBERNETES_RECIPES)?.tool).toBe("helm")
		const alchemy = recipe(model, Recipe.Message.ClickedMethod({ method: "alchemy" }))
		expect(Recipe.selectedRecipe(alchemy.recipe, KUBERNETES_RECIPES)?.tool).toBe("alchemy")
	})

	it("starts over on Helm with the key masked after it closes", () => {
		const opened = send(init("install", "kubernetes"), Message.ClickedOpen())
		const changed = recipe(
			recipe(opened, Recipe.Message.ClickedMethod({ method: "terraform" })),
			Recipe.Message.ClickedToggleReveal(),
		)
		const closed = send(changed, Message.GotDialogMessage({ message: Dialog.Message.ClickedClose() }))
		expect(Recipe.selectedRecipe(closed.recipe, KUBERNETES_RECIPES)?.tool).toBe("helm")
		expect(closed.recipe.isRevealed).toBe(false)
	})
})
