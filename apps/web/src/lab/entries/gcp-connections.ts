import * as Page from "../gcp-connections-lab"
import { GcpLabFlags, gcpLabFlags } from "../gcp-host"
import { defineShellLab } from "../shell-lab"

// `/lab/gcp-connections`: every Google Cloud connection state.

export const lab = defineShellLab("Google Cloud connections", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: GcpLabFlags,
	flags: gcpLabFlags,
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/gcp-connections",
	breadcrumbs: [{ label: "Lab" }, { label: "Google Cloud connections" }],
})
