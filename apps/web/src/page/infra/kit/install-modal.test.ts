import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Recipe from "../../kit/install-recipe"
import { init, Message, type Model, update } from "./install-modal"
import { keyOf } from "./install-modal-view"
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

	it("offers no command when the key read fails, and the key masked once it loads", () => {
		const mounted = send(init("install", "kubernetes"), Message.MountedInstallModal())
		const failed = send(
			mounted,
			Message.CompletedFetchIngestKey({ result: Result.fail(toLoadFailure(new Error("forbidden"))) }),
		)
		expect([keyOf(failed).isLoading, keyOf(failed).unavailable === undefined]).toEqual([false, false])
		const loaded = send(
			mounted,
			Message.CompletedFetchIngestKey({ result: Result.succeed("maple_pk_abcdef0123") }),
		)
		expect(keyOf(loaded)).toEqual({
			isLoading: false,
			value: "maple_pk_abcdef0123",
			masked: Recipe.maskSecret("maple_pk_abcdef0123"),
			unavailable: undefined,
		})
	})
})
