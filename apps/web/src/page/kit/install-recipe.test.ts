import { String as Str } from "effect"
import { describe, expect, it } from "vitest"
import * as Recipe from "./install-recipe"

const RECIPES: ReadonlyArray<Recipe.InstallRecipe> = [
	{ tool: "helm", steps: [] },
	{ tool: "terraform", steps: [] },
]

describe("install recipe", () => {
	it("falls back to the first recipe when the picked tool is not among them", () => {
		const picked = Recipe.update(Recipe.init(), Recipe.Message.ClickedMethod({ method: "alchemy" })).model
		expect(Recipe.selectedRecipe(picked, RECIPES)?.tool).toBe("helm")
		const terraform = Recipe.update(picked, Recipe.Message.ClickedMethod({ method: "terraform" })).model
		expect(Recipe.selectedRecipe(terraform, RECIPES)?.tool).toBe("terraform")
	})

	it("opens and folds one file without touching the others", () => {
		const toggle = (model: Recipe.Model, id: string) =>
			Recipe.update(model, Recipe.Message.ClickedToggleFile({ id })).model
		const both = toggle(toggle(Recipe.init(), "alchemy"), "terraform")
		expect(toggle(both, "alchemy").openFiles).toEqual(["terraform"])
	})

	it("keeps a key's type prefix when it masks it, and nothing else", () => {
		const masked = Recipe.maskSecret("maple_sk_abc123secret")
		expect(Str.startsWith("maple_sk_")(masked)).toBe(true)
		expect(masked).not.toContain("abc123")
		expect(Recipe.maskSecret("plainsecret")).not.toContain("plain")
	})
})
