import * as Page from "../gcp-connect-lab/model"
import { init, update } from "../gcp-connect-lab/update"
import { view } from "../gcp-connect-lab/view"
import { defineLabWithFlags } from "../define"
import { GcpLabFlags, gcpLabFlags } from "../gcp-host"

// `/lab/gcp-connect`: the connect dialog's steps and run
// states, bare (outside the shell).

export const lab = defineLabWithFlags("Google Cloud connect flow", {
	Model: Page.Model,
	Flags: GcpLabFlags,
	flags: gcpLabFlags,
	init,
	update,
	view,
})
