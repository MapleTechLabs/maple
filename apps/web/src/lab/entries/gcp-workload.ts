import { GcpWorkloadLabFlags, Message, Model } from "../gcp-workload-lab/model"
import { gcpWorkloadLabFlags, init, update } from "../gcp-workload-lab/update"
import { breadcrumbs, overlay, view } from "../gcp-workload-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/gcp-workload`: the Google Cloud workload page,
// whole, over fixture series: a Cloud Run burst and a Cloud SQL instance, inside the real shell.

export const lab = defineShellLab("Google Cloud workload", {
	Model,
	Message,
	Flags: GcpWorkloadLabFlags,
	flags: gcpWorkloadLabFlags,
	init,
	update,
	view,
	before: overlay,
	currentPath: "/lab/gcp-workload",
	breadcrumbs,
})
