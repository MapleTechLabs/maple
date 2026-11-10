import { Effect, Schema } from "effect"
import { init, Message, Model, update, view } from "../condition-builder-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/condition-builder`: the query panel's condition rows over fixture vocabulary, inside the
// real shell so the kit tooltips show.

export const lab = defineShellLab("Condition builder", {
	Model,
	Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init,
	update,
	view,
	currentPath: "/lab/condition-builder",
	breadcrumbs: [{ label: "Lab" }, { label: "Condition builder" }],
})
