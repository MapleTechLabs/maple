import { Effect, Schema } from "effect"
import * as Page from "../search-console-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/search-console`: every Google Search Console card state.

export const lab = defineShellLab("Google Search Console", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/search-console",
	breadcrumbs: [{ label: "Lab" }, { label: "Google Search Console" }],
})
