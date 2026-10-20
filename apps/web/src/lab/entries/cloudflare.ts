import * as Page from "../cloudflare-lab/model"
import { flags, init, update } from "../cloudflare-lab/update"
import { breadcrumbs, toolbar, view } from "../cloudflare-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/cloudflare`: the list, zone and Worker pages over fixtures.

export const lab = defineShellLab("Cloudflare", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: Page.Flags,
	flags,
	init,
	update,
	view,
	before: toolbar,
	currentPath: "/lab/cloudflare",
	breadcrumbs,
})
