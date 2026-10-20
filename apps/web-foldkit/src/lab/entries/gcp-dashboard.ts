import { Effect, Schema } from "effect"
import { Message } from "../../page/dashboards/view/message"
import { Model } from "../../page/dashboards/view/model"
import { DASHBOARD } from "../gcp-dashboard-lab/fixture"
import { init, update } from "../gcp-dashboard-lab/update"
import { view } from "../gcp-dashboard-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/gcp-dashboard`: the Google Cloud template as a
// board inside the real shell, with no API.

export const lab = defineShellLab("Google Cloud dashboard", {
	Model,
	Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init,
	update,
	view,
	currentPath: "/lab/gcp-dashboard",
	breadcrumbs: [{ label: "Lab", href: "/lab" }, { label: DASHBOARD.name }],
})
