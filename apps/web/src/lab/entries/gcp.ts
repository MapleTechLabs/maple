import { Effect, Schema } from "effect"
import * as Page from "../gcp-filter-lab/model"
import { init, update } from "../gcp-filter-lab/update"
import { view } from "../gcp-filter-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/gcp`: the Google Cloud log filter field in each of its states.

const NoFlags = Schema.Struct({})

export const lab = defineShellLab("Google Cloud log filter", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: NoFlags,
	flags: Effect.succeed({}),
	init: () => ({ model: init() }),
	update,
	view,
	currentPath: "/lab/gcp",
	breadcrumbs: [{ label: "Lab" }, { label: "Google Cloud log filter" }],
})
