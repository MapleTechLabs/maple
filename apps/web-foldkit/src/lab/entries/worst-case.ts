import { defineLabWithFlags } from "../define"
import { Flags, Model } from "../worst-case-lab/model"
import { init, update, worstCaseFlags } from "../worst-case-lab/update"
import { view } from "../worst-case-lab/view"

// `/lab/worst-case` (apps/web `lab/worst-case-lab.tsx`): product components over worst-case data,
// a bare page as legacy's route renders it.

export const lab = defineLabWithFlags("Worst case", {
	Model,
	Flags,
	flags: worstCaseFlags,
	init,
	update,
	view,
})
