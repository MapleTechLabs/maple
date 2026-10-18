import { defineLab } from "../define"
import { Model } from "../timeline-lab/model"
import { init, update } from "../timeline-lab/update"
import { view } from "../timeline-lab/view"

// `/lab/timeline` (apps/web `lab/timeline-lab.tsx`): the trace view tabs over a synthetic trace.

export const lab = defineLab("Trace timeline", { Model, init, update, view })
