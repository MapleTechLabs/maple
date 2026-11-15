import { GcpLabFlags, gcpLabFlags } from "../gcp-host"
import * as Page from "../integration-features-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/integration-features`: the Supabase and GitHub cards and their feature switches.

export const lab = defineShellLab("Integration features", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: GcpLabFlags,
	flags: gcpLabFlags,
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/integration-features",
	breadcrumbs: [{ label: "Lab" }, { label: "Integration features" }],
})
