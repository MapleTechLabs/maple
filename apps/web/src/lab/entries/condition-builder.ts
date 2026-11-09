import { defineLab } from "../define"
import { init, Model, update, view } from "../condition-builder-lab"

// `/lab/condition-builder`: the query panel's condition rows over fixture vocabulary.

export const lab = defineLab("Condition builder", { Model, init, update, view })
