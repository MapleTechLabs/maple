import { defineLabWithFlags } from "../define"
import { Flags, Model } from "../worst-case-lab/model"
import { init, update, worstCaseFlags } from "../worst-case-lab/update"
import { view } from "../worst-case-lab/view"

// `/lab/worst-case`: product components over worst-case data,
// a bare page.

export const lab = defineLabWithFlags("Worst case", {
	Model,
	Flags,
	flags: worstCaseFlags,
	init,
	update,
	view,
})
