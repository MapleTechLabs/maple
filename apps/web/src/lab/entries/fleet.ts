import { Effect, Schema } from "effect"
import * as Page from "../fleet-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/fleet`: every Fleet card state.

export const lab = defineShellLab("Fleet", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/fleet",
	breadcrumbs: [{ label: "Lab" }, { label: "Fleet" }],
})
