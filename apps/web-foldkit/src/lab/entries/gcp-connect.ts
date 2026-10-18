import * as Page from "../gcp-connect-lab/model"
import { init, update } from "../gcp-connect-lab/update"
import { view } from "../gcp-connect-lab/view"
import { defineLabWithFlags } from "../define"
import { GcpLabFlags, gcpLabFlags } from "../gcp-host"

// `/lab/gcp-connect` (apps/web `lab/gcp-connect-lab.tsx`): the connect dialog's steps and run
// states, bare (legacy renders it outside `DashboardLayout`).

export const lab = defineLabWithFlags("Google Cloud connect flow", {
	Model: Page.Model,
	Flags: GcpLabFlags,
	flags: gcpLabFlags,
	init,
	update,
	view,
})
