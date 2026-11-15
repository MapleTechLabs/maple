import { defineLab } from "../define"
import { Model, init, update, view } from "../promql-widget-lab"

// `/lab/promql-widget`: the widget editor over a PromQL line chart, `?state=error` for a parse error.

export const lab = defineLab("PromQL widget", { Model, init, update, view })
