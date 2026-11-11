import { defineLabWithFlags } from "../define"
import { Flags, flags, init, Model, update, view } from "../rule-editor-lab"

// `/lab/rule-editor`: the alert rule editor over fixture rows (`?variant=populated|new|anomaly`).

export const lab = defineLabWithFlags("Rule editor", { Model, Flags, flags, init, update, view })
