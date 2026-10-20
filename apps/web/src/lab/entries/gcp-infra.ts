import { Effect, Schema } from "effect"
import { Message, Model } from "../gcp-infra-lab/model"
import { init, update } from "../gcp-infra-lab/update"
import { overlay, view } from "../gcp-infra-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/gcp-infra`: the redesigned Google Cloud list, whole,
// over fixtures that reproduce the Paper artboards, inside the real shell.

export const lab = defineShellLab("Google Cloud", {
	Model,
	Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: () => init(),
	update,
	view,
	before: overlay,
	currentPath: "/lab/gcp-infra",
	breadcrumbs: [{ label: "Infrastructure" }, { label: "Google Cloud" }],
})
