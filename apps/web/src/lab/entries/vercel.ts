import { GcpLabFlags, gcpLabFlags } from "../gcp-host"
import { defineShellLab } from "../shell-lab"
import * as Page from "../vercel-lab"

// `/lab/vercel`: every Vercel card state, and the connect dialog's steps.

export const lab = defineShellLab("Vercel integration", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: GcpLabFlags,
	flags: gcpLabFlags,
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/vercel",
	breadcrumbs: [{ label: "Lab" }, { label: "Vercel integration" }],
})
