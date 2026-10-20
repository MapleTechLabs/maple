import { defineLabWithFlags } from "../define"
import { Flags, flags, init, Model, update } from "../infra-lab/update"
import { view } from "../infra-lab/view"

// `/lab/infra`: the infra overview, hosts and Railway lists over fixtures.

export const lab = defineLabWithFlags("Infrastructure", { Model, Flags, flags, init, update, view })
