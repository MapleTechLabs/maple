import type { AlertRuleDocument } from "@maple/domain/http"
import { defaultRuleForm, ruleToFormState } from "@maple/web-data/alerts/form-utils"
import { switchSignalKind } from "@maple/web-data/alerts/rule-modes"
import { buildRuleStatesByRuleId, rowToAlertRuleDocument } from "@maple/web-data/collections/alerts"
import { createWidgetAlertPrefill, resolveWidgetAlertPrefill } from "../../../lib/alerts/widget-prefill"
import { Option, Schema } from "effect"
import { ALERT_TEMPLATES } from "../shared/templates"
import { fromFormState, type RuleForm } from "./form"
import type { Model, Notice } from "./model"

// `deriveRuleInitialization`: which draft the
// page opens on, once the inputs it needs have answered.

export type Initialization =
	| { readonly _tag: "Loading" }
	| { readonly _tag: "Failed" }
	| {
			readonly _tag: "Ready"
			readonly key: string
			readonly form: RuleForm
			readonly notices: ReadonlyArray<Notice>
			readonly editingRule: AlertRuleDocument | null
			readonly isShowingTemplates: boolean
	  }

/** A fresh draft's query takes the id read on entry, so the form is a function of the Model. */
const withDraftId = (form: RuleForm, id: string): RuleForm => ({
	...form,
	queryBuilderDraft: { ...form.queryBuilderDraft, id },
})

/** New rules open in the query builder; the default error-rate signal carries over as a query. */
export const baseForm = (serviceName: string | undefined, draftId: string): RuleForm =>
	fromFormState(switchSignalKind(withDraftId(defaultRuleForm(serviceName), draftId), "builder_query").form)

const ready = (
	key: string,
	form: RuleForm,
	notices: ReadonlyArray<Notice> = [],
	editingRule: AlertRuleDocument | null = null,
	isShowingTemplates = false,
): Initialization => ({ _tag: "Ready", key, form, notices, editingRule, isShowingTemplates })

// `decodeAlertChartFromSearchParam`.
const AlertChartContext = Schema.Struct({
	dashboardId: Schema.String,
	widget: Schema.Struct({
		id: Schema.String,
		visualization: Schema.optional(Schema.String),
		dataSource: Schema.optional(Schema.Unknown),
		display: Schema.optional(Schema.Struct({ title: Schema.optional(Schema.String) })),
	}),
})
const decodeChart = Schema.decodeUnknownOption(Schema.fromJsonString(AlertChartContext))
const fromBase64Url = (input: string): Option.Option<string> =>
	Option.liftThrowable(() => {
		const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
		return decodeURIComponent(escape(atob(padded)))
	})()
export const decodeChartParam = (raw: string) => Option.flatMap(fromBase64Url(raw), decodeChart)

/** The rule being edited, from the live rows. */
export const editingRuleOf = (model: Model, ruleId: string): AlertRuleDocument | null => {
	const row = (model.rules ?? []).find((candidate) => candidate.id === ruleId)
	return row === undefined ? null : rowToAlertRuleDocument(row, buildRuleStatesByRuleId(model.states ?? []))
}

export const initialization = (model: Model, draftId: string): Initialization => {
	const search = model.search
	const base = baseForm(search.serviceName, draftId)
	if (search.ruleId !== undefined) {
		// Terminal: an edit must not silently turn into a create, so the page stops here.
		if (model.rules === null) return model.isRulesLoadFailed ? { _tag: "Failed" } : { _tag: "Loading" }
		const rule = editingRuleOf(model, search.ruleId)
		if (rule !== null) {
			const form = fromFormState(ruleToFormState(rule))
			return ready(`rule:${rule.id}`, rule.queryBuilderDraft === null ? withDraftId(form, draftId) : form, [], rule)
		}
		return ready(`missing-rule:${search.ruleId}`, base, [
			{ severity: "warning", message: "The alert rule could not be found. Starting from a blank alert." },
		])
	}
	const chart = search.chart === undefined ? Option.none() : decodeChartParam(search.chart)
	if (Option.isSome(chart)) {
		const result = createWidgetAlertPrefill(chart.value.widget, base)
		return ready(`chart:${chart.value.dashboardId}:${chart.value.widget.id}`, fromFormState(result.form), result.notices)
	}
	if (search.dashboardId !== undefined || search.widgetId !== undefined) {
		if (search.dashboardId === undefined || search.widgetId === undefined) {
			const result = resolveWidgetAlertPrefill({
				dashboards: [],
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return ready(
				`missing-chart-source:${search.dashboardId ?? "dashboard"}:${search.widgetId ?? "widget"}`,
				fromFormState(result.form),
				result.notices,
			)
		}
		// No snapshot (an oversized one is dropped): the id lookup over the dashboards list.
		if (model.sourceDashboards !== null) {
			const result = resolveWidgetAlertPrefill({
				dashboards: model.sourceDashboards,
				dashboardId: search.dashboardId,
				widgetId: search.widgetId,
				base,
			})
			return ready(`dashboard:${search.dashboardId}:widget:${search.widgetId}`, fromFormState(result.form), result.notices)
		}
		if (!model.isDashboardsLoadFailed) return { _tag: "Loading" }
		return ready(`dashboard-load-failed:${search.dashboardId}:${search.widgetId}`, base, [
			{ severity: "warning", message: "Dashboards could not be loaded. Starting from a blank alert." },
		])
	}
	const template = ALERT_TEMPLATES.find((candidate) => candidate.id === search.template)
	if (template !== undefined) return ready(`new:template:${template.id}`, fromFormState(template.apply(base)))
	return ready(`new:${search.serviceName ?? "blank"}`, base, [], null, search.serviceName === undefined)
}
