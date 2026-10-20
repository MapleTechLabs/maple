import * as Keyed from "../../../data/keyed"
import { resolveWindow } from "../../../data/time-range"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import { Command } from "foldkit"
import type { PageContext } from "../../contract"
import * as DestinationDialog from "../destination/dialog"
import { completeSave, completeTest, runTest, save } from "./actions"
import { FocusSqlCaret, InsertSqlToken, ReloadPage } from "./command"
import { SQL_TEXTAREA_ID } from "./view-sql"
import { chatConnectStep, connectorsAnswered, liftDialog, menuStep, removeDestination } from "./dest-steps"
import { suggestedName } from "./derive"
import { tagSuggestionsOf } from "./derive-rows"
import * as F from "./form-steps"
import { Message } from "./message"
import type { Model } from "./model"
import { planAutocomplete, planPreviews } from "./plan"
import { editForm, followRows, initialize, liftTemplates, type Return } from "./steps"
import { chartStep, comboStep, queryPanelStep, radioStep, selectStep, timePickerStep } from "./sub-steps"

const AUTOCOMPLETE_PRESET = "24h"

const ofOrg = (model: Model, context: PageContext, orgId: string, step: () => Return): Return =>
	orgId === context.orgId ? step() : { model }

/** The clock read: the provider's 24h window (once) and the preview's lookback. */
const readClock = (model: Model, context: PageContext, nowMs: number): Return => {
	const resolve = (preset: string) => resolveWindow({ preset, snap: true, timeZone: context.timeZone }, nowMs)
	const previewWindow = resolve(model.previewPreset)
	const windows: Model = {
		...model,
		autocompleteWindow: model.autocompleteWindow ?? resolve(AUTOCOMPLETE_PRESET),
		// The same snapped window keeps its reference, so the chart is not rebuilt for it.
		previewWindow:
			model.previewWindow !== null &&
			model.previewWindow.startTime === previewWindow.startTime &&
			model.previewWindow.endTime === previewWindow.endTime
				? model.previewWindow
				: previewWindow,
	}
	const looked = planAutocomplete(windows, context)
	const previewed = planPreviews(looked.model, context)
	return { model: previewed.model, commands: [...looked.commands, ...previewed.commands] }
}

const closeTemplates = (model: Model): Return => liftTemplates(model, Dialog.close(model.templates))

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		UpdatedRules: ({ orgId, rows }) =>
			ofOrg(model, context, orgId, () =>
				followRows({ ...model, rules: rows, tagSuggestions: tagSuggestionsOf(rows, model.tagSuggestions) }, context),
			),
		UpdatedRuleStates: ({ orgId, rows }) => ofOrg(model, context, orgId, () => ({ model: { ...model, states: rows } })),
		UpdatedIncidents: ({ orgId, rows }) => ofOrg(model, context, orgId, () => ({ model: { ...model, incidents: rows } })),
		UpdatedDestinations: ({ orgId, rows }) =>
			ofOrg(model, context, orgId, () => followRows({ ...model, destinations: rows }, context)),
		// A verdict only counts while nothing has answered: a resolved list is the answer.
		FailedLoadRules: ({ orgId }) =>
			ofOrg(model, context, orgId, () =>
				model.rules === null ? initialize({ ...model, isRulesLoadFailed: true }, context) : { model },
			),
		UpdatedSourceDashboard: ({ orgId, dashboards }) =>
			ofOrg(model, context, orgId, () => followRows({ ...model, sourceDashboards: dashboards }, context)),
		FailedLoadDashboards: ({ orgId }) =>
			ofOrg(model, context, orgId, () =>
				model.sourceDashboards === null ? followRows({ ...model, isDashboardsLoadFailed: true }, context) : { model },
			),
		ClickedReloadPage: () => ({ model, commands: [ReloadPage()] }),
		ReloadedPage: () => ({ model }),
		GeneratedDraftId: ({ id }) => initialize({ ...model, draftId: id }, context),
		CompletedReadClock: ({ nowMs }) => readClock(model, context, nowMs),
		CompletedReadIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedFetchConnectors: ({ connectors }) => connectorsAnswered(model, connectors),
		GotChatConnectMessage: ({ message: inner }) => chatConnectStep(model, inner),
		CompletedFetchTraceFacets: ({ key, result }) => ({
			model: { ...model, traceFacets: Keyed.accept(model.traceFacets, key, result) },
		}),
		CompletedFetchAutocomplete: ({ key, lookup, result }) => {
			const slot = model.autocomplete[lookup]
			return slot === undefined
				? { model }
				: { model: { ...model, autocomplete: { ...model.autocomplete, [lookup]: Keyed.accept(slot, key, result) } } }
		},
		// Both slots take an answer for their key: the replay can share the draft's first request.
		CompletedFetchPreview: ({ key, result }) => ({
			model: {
				...model,
				preview: model.preview.key === key ? Keyed.accept(model.preview, key, result) : model.preview,
				savedPreview: model.savedPreview.key === key ? Keyed.accept(model.savedPreview, key, result) : model.savedPreview,
			},
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		GotChartMessage: ({ message: inner }) => chartStep(model, inner),
		GotTimePickerMessage: ({ message: inner }) => timePickerStep(model, inner),
		ClickedSignalKind: ({ kind }) => {
			if (model.form === null) return { model }
			const moved = F.switchKind(model.form, kind)
			return editForm({ ...model, kindNotice: moved.notice }, context, () => moved.form)
		},
		GotRadioMessage: ({ group, message: inner }) => radioStep(model, context, group, inner),
		ClickedOpenInBuilder: () => {
			if (model.form === null) return { model }
			const moved = F.switchKind(model.form, "builder_query")
			return editForm({ ...model, kindNotice: moved.notice }, context, () => moved.form)
		},
		GotQueryPanelMessage: ({ message: inner }) => queryPanelStep(model, context, inner),
		GotSelectMessage: ({ id, message: inner }) => selectStep(model, context, id, inner),
		GotComboMessage: ({ id, message: inner }) => comboStep(model, context, id, inner),
		ChangedField: ({ field, value }) => editForm(model, context, (form) => F.setText(form, field, value)),
		ChangedEscalationField: ({ field, value }) =>
			editForm(model, context, (form) => F.setEscalationField(form, field, value)),
		ClickedAddCriticalTier: () => editForm(model, context, F.addCriticalTier),
		ClickedRemoveCriticalTier: () => editForm(model, context, (form) => ({ ...form, escalation: null })),
		ToggledAlertOnNoData: () => editForm(model, context, (form) => ({ ...form, alertOnNoData: !form.alertOnNoData })),
		ClickedDryRun: () => runTest(model, false),
		ClickedSendTest: () => runTest(model, true),
		CompletedTest: (completed) => completeTest(model, completed),
		ClickedSave: () => save(model),
		CompletedSave: (completed) => completeSave(model, completed),
		TrackedRuleCreated: () => ({ model }),
		ClickedShowTemplates: () => liftTemplates(model, Dialog.open(model.templates)),
		GotTemplatesMessage: ({ message: inner }) => liftTemplates(model, Dialog.update(model.templates, inner)),
		ClickedTemplate: ({ id }) => {
			const closed = closeTemplates(model)
			const edited = editForm(closed.model, context, (form) => F.pickTemplate(form, id))
			return { ...edited, commands: [...(closed.commands ?? []), ...(edited.commands ?? [])] }
		},
		ClickedStartBlank: () => closeTemplates(model),
		ClickedSkipTemplates: () => closeTemplates(model),
		ClickedSuggestName: () => editForm(model, context, (form) => ({ ...form, name: suggestedName(form) ?? form.name })),
		ChangedTagDraft: ({ value }) => ({ model: { ...model, tagDraft: value } }),
		PressedTagKey: ({ key }) => {
			if (key === "Backspace") {
				const last = model.form?.tags.at(-1)
				return model.tagDraft.length > 0 || last === undefined
					? { model }
					: editForm(model, context, (form) => F.removeTag(form, last))
			}
			return editForm({ ...model, tagDraft: "" }, context, (form) => F.commitTag(form, model.tagDraft))
		},
		BlurredTagInput: () => editForm({ ...model, tagDraft: "" }, context, (form) => F.commitTag(form, model.tagDraft)),
		ClickedRemoveTag: ({ tag }) => editForm(model, context, (form) => F.removeTag(form, tag)),
		ClickedAddNotes: () => ({ model: { ...model, isNotesOpen: true } }),
		ToggledSqlCollapsed: () => ({ model: { ...model, isSqlCollapsed: !model.isSqlCollapsed } }),
		ClickedSqlToken: ({ token }) =>
			model.form === null
				? { model }
				: { model, commands: [InsertSqlToken({ id: SQL_TEXTAREA_ID, sql: model.form.rawQuerySql, token })] },
		CompletedInsertSqlToken: ({ sql, caret }) => {
			const edited = editForm(model, context, (form) => ({ ...form, rawQuerySql: sql }))
			return { ...edited, commands: [...(edited.commands ?? []), FocusSqlCaret({ id: SQL_TEXTAREA_ID, caret })] }
		},
		CompletedFocusSql: () => ({ model }),
		ToggledMessageTemplate: () => ({ model: { ...model, isMessageTemplateOpen: !model.isMessageTemplateOpen } }),
		ClickedTemplateVariable: ({ key }) => editForm(model, context, (form) => F.appendVariable(form, key)),
		GotMenuMessage: ({ id, message: inner }) => menuStep(model, id, inner),
		ClickedRemoveDestination: ({ tier, id }) => removeDestination(model, tier, id),
		GotDestinationDialogMessage: ({ message: inner }) =>
			liftDialog(model, DestinationDialog.update(model.destinationDialog, inner)),
		GotIssuesTooltipMessage: ({ message: inner }) => {
			const step = Tooltip.update(model.issuesTooltip, inner)
			return {
				model: { ...model, issuesTooltip: step.model },
				commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotIssuesTooltipMessage({ message })),
			}
		},
		FailedLoadProviderLogo: ({ type }) =>
			model.brokenLogos.includes(type) ? { model } : { model: { ...model, brokenLogos: [...model.brokenLogos, type] } },
	})
