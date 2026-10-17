import { Link, useNavigate } from "@tanstack/react-router"
import { Exit } from "effect"
import { useMemo, useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

import type { AlertDestinationDocument, AlertRuleDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { DetailsSection } from "@/components/alerts/details-section"
import { NotificationsSection } from "@/components/alerts/notifications-section"
import { DestinationDialog } from "@/components/alerts/destination-dialog"
import { useDestinationManager } from "@/components/alerts/overview/routing-tab"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { RuleActionBar } from "@/components/alerts/rule-action-bar"
import { RULE_FORM_MAX_WIDTH } from "@/components/alerts/rule-form-layout"
import {
	RuleConditionFields,
	conditionSubject,
	describeRuleCondition,
} from "@/components/alerts/rule-condition-bar"
import { RuleStep } from "@/components/alerts/rule-step"
import { RuleLiveChartHero } from "@/components/alerts/rule-live-chart-hero"
import { RuleNoiseSection } from "@/components/alerts/rule-noise-section"
import { RuleQuerySection } from "@/components/alerts/rule-query-section"
import { RuleTemplatesOverlay } from "@/components/alerts/rule-templates-overlay"
import { WidgetPrefillNoticeBanner } from "@/components/alerts/widget-prefill-notice-banner"
import { DashboardPage } from "@/components/layout/dashboard-page"
import type { TimeRange } from "@/components/time-range-picker/types"
import { trackProduct } from "@/lib/analytics"
import { useAlertRulePreview } from "@/hooks/use-alert-rule-preview"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAutocompleteValuesContext } from "@/hooks/use-autocomplete-values"
import {
	buildRuleCreateParamsV2,
	buildRuleTestParamsV2,
	deriveRuleQueryIssues,
	deriveTierIssues,
	isFilledNumber,
	isRangeComparator,
	isRulePreviewReady,
	pickDefaultDestination,
	ruleToFormState,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { diffRuleForms, incidentsClearedByDraft } from "@/lib/alerts/preview-insights"
import { toastExit } from "@/lib/error-toast"
import { applyTemplate } from "@/lib/alerts/templates"
import { switchSignalKind } from "@/lib/alerts/rule-modes"
import type { WidgetAlertPrefillNotice } from "@/lib/alerts/widget-prefill"
import { Result, useAtomSet } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"

/** Preview lookback the form opens on: a week shows how often the rule would really fire. */
const DEFAULT_PREVIEW_PRESET = "7d"

export function AlertCreateFormSurface({
	initialForm,
	prefillNotices,
	editingRule,
	showTemplatesInitially,
	destinations,
	serviceNameOptions,
	environmentOptions,
	autocompleteValues,
}: {
	initialForm: RuleFormState
	prefillNotices: WidgetAlertPrefillNotice[]
	editingRule: AlertRuleDocument | null
	showTemplatesInitially: boolean
	destinations: AlertDestinationDocument[]
	serviceNameOptions: string[]
	environmentOptions: string[]
	autocompleteValues: ReturnType<typeof useAutocompleteValuesContext>
}) {
	const navigate = useNavigate({ from: "/alerts/create" })
	const createRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "create"), {
		mode: "promiseExit",
	})
	const updateRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "update"), {
		mode: "promiseExit",
	})
	const testRule = useAtomSet(MapleApiV2AtomClient.mutation("alertRules", "test"), {
		mode: "promiseExit",
	})

	const [ruleForm, setRuleForm] = useState<RuleFormState>(() => initialForm)
	// A destination made from this form is selected on it: the user came here to
	// write a rule, and leaving to make the destination would have lost the draft.
	// Creating a destination is admin-only server-side; a member gets the nudge, not the dialog.
	const isAdmin = useIsOrgAdmin()
	const destinationManager = useDestinationManager({
		onCreated: (id) =>
			setRuleForm((current) => ({
				...current,
				destinationIds: [...new Set([...current.destinationIds, id])],
			})),
	})
	// Tagged with the rule config it was produced from. A "Would trigger" verdict
	// is only meaningful for the exact signal/threshold/scope that was tested, so
	// editing any of those makes the stored result stale rather than wrong-but-shown.
	// Compared at render time — no effect needed to clear it.
	const [previewResult, setPreviewResult] = useState<{
		key: string
		status: "breached" | "healthy" | "skipped"
		value: number | null
		sampleCount: number
		reason: string
	} | null>(null)

	// First-touch template picker: shown only when this is a fresh new-rule
	// entry with no pre-fills.
	const [templatesOpen, setTemplatesOpen] = useState(() => showTemplatesInitially)

	// Preview-only lookback. Deliberately component-local: it tunes what the
	// chart shows while authoring and is never part of the rule that gets saved,
	// so it stays out of the URL and out of `ruleForm`.
	const [previewTimeRange, setPreviewTimeRange] = useState<TimeRange>({
		presetValue: DEFAULT_PREVIEW_PRESET,
	})
	const previewRange = useEffectiveTimeRange(
		previewTimeRange.startTime,
		previewTimeRange.endTime,
		previewTimeRange.presetValue ?? DEFAULT_PREVIEW_PRESET,
	)

	const { preview, previewLoading, previewError } = useAlertRulePreview(ruleForm, previewRange)

	// Edit mode replays the saved rule over the same window, but only once the
	// draft evaluates differently; until then the two charts would be identical.
	const savedForm = useMemo(() => (editingRule ? ruleToFormState(editingRule) : null), [editingRule])
	const changes = useMemo(
		() => (savedForm === null ? [] : diffRuleForms(savedForm, ruleForm)),
		[savedForm, ruleForm],
	)
	const evaluationChanged =
		savedForm !== null && previewIdentityKey(savedForm) !== previewIdentityKey(ruleForm)
	const savedReplay = useAlertRulePreview(evaluationChanged ? savedForm : null, previewRange)
	const { result: incidentsResult } = useAlertIncidentsList()
	const clearedIncidents = useMemo(() => {
		if (editingRule === null || !evaluationChanged) return []
		const open = Result.builder(incidentsResult)
			.onSuccess((response) =>
				response.incidents.filter(
					(incident) => incident.ruleId === editingRule.id && incident.status === "open",
				),
			)
			.orElse(() => [])
		return incidentsClearedByDraft(open, preview)
	}, [editingRule, evaluationChanged, incidentsResult, preview])

	const validationIssues = useMemo(() => deriveValidationIssues(ruleForm), [ruleForm])

	const suggestedName = useMemo(() => makeSuggestedName(ruleForm), [ruleForm])

	const { result: rulesResult } = useAlertRulesList()

	// A new rule starts on the destination the org's rules already use most (or the only one), once
	// the list has answered. Adjusted during render, not in an effect; it runs once per form.
	const [defaultDestinationApplied, setDefaultDestinationApplied] = useState(editingRule !== null)
	if (!defaultDestinationApplied && destinations.length > 0 && Result.isSuccess(rulesResult)) {
		setDefaultDestinationApplied(true)
		const fallback = pickDefaultDestination(destinations, rulesResult.value.rules)
		if (fallback !== null && ruleForm.destinationIds.length === 0) {
			setRuleForm((current) =>
				current.destinationIds.length === 0 ? { ...current, destinationIds: [fallback] } : current,
			)
		}
	}

	// Tags already in use across the org's rules, offered as autocomplete so
	// teams converge on a shared vocabulary instead of typo-forking groups.
	const tagSuggestions = useMemo(
		() =>
			Result.builder(rulesResult)
				.onSuccess((response) => [...new Set(response.rules.flatMap((rule) => rule.tags))].sort())
				.orElse(() => [] as string[]),
		[rulesResult],
	)

	const [handleSave, savingRule] = useAsyncAction(async () => {
		const payload = buildRuleCreateParamsV2(ruleForm)
		const result = editingRule
			? await updateRule({
					params: { id: editingRule.id },
					payload,
					reactivityKeys: ["alertRules"],
				})
			: await createRule({ payload, reactivityKeys: ["alertRules"] })

		const success = editingRule ? "Rule updated" : "Rule created"
		if (toastExit(result, { success, error: "Failed to save rule" })) {
			if (!editingRule) trackProduct("alert_rule_created", { signal: ruleForm.signalType })
			navigate({ to: "/alerts" })
		}
	})

	async function runTest(sendNotification: boolean) {
		if (!isRulePreviewReady(ruleForm)) {
			toastManager.add({
				title: "Complete the rule name, query, and threshold before testing",
				type: "error",
			})
			return
		}
		const testedKey = previewIdentityKey(ruleForm)
		const result = await testRule({
			payload: buildRuleTestParamsV2(ruleForm, sendNotification),
			reactivityKeys: ["alertDeliveryEvents"],
		})
		const success = sendNotification ? "Preview ran and sent a test notification" : "Preview updated"
		if (!toastExit(result, { success, error: "Failed to preview rule" })) return
		if (Exit.isSuccess(result)) {
			setPreviewResult({
				key: testedKey,
				status: result.value.status,
				value: result.value.value,
				sampleCount: result.value.sample_count,
				reason: result.value.reason,
			})
		}
	}
	const [previewRule, previewingRule] = useAsyncAction(() => runTest(false))
	const [sendTestNotification, sendingTestNotification] = useAsyncAction(() => runTest(true))

	// Drop the verdict as soon as the user edits anything it depended on.
	const currentPreviewKey = previewIdentityKey(ruleForm)
	const freshPreviewResult = previewResult?.key === currentPreviewKey ? previewResult : null
	const thresholdMissing = !isFilledNumber(ruleForm.threshold)

	return (
		<>
			<DashboardPage
				breadcrumbs={[
					{ label: "Alerts", href: "/alerts" },
					{ label: editingRule ? "Edit rule" : "New rule" },
				]}
			>
				<div className={cn("mx-auto w-full space-y-10", RULE_FORM_MAX_WIDTH)}>
					<WidgetPrefillNoticeBanner notices={prefillNotices} />
					<RuleStep
						number={1}
						divider={false}
						title="What to watch"
						hint="Pick a built-in signal, or build the query like a dashboard widget."
						status="done"
					>
						<RuleQuerySection
							form={ruleForm}
							onChange={setRuleForm}
							autocompleteValues={autocompleteValues}
							serviceNameOptions={serviceNameOptions}
							environmentOptions={environmentOptions}
						/>
					</RuleStep>
					<RuleStep
						number={2}
						title="When to alert"
						hint="The dashed line is your threshold. Shaded bands show when the rule would have fired."
						status={thresholdMissing ? "missing" : "done"}
					>
						<div className="space-y-4">
							<RuleLiveChartHero
								form={ruleForm}
								preview={preview}
								previewLoading={previewLoading}
								previewError={previewError}
								onTestRule={() => void previewRule()}
								testing={previewingRule}
								previewResult={freshPreviewResult}
								range={previewRange}
								timeRange={previewTimeRange}
								onTimeRangeChange={setPreviewTimeRange}
								comparison={
									savedForm !== null && changes.length > 0
										? {
												savedPreview: evaluationChanged
													? savedReplay.preview
													: preview,
												savedLoading: evaluationChanged && savedReplay.previewLoading,
												changes,
												clearedIncidents,
											}
										: null
								}
							/>
							<RuleConditionFields form={ruleForm} onChange={setRuleForm} saved={savedForm} />
							<RuleNoiseSection form={ruleForm} onChange={setRuleForm} />
						</div>
					</RuleStep>
					<div className="grid gap-6 border-t pt-8 lg:grid-cols-2 lg:items-start">
						<RuleStep
							number={3}
							divider={false}
							title="Who gets notified"
							status={
								ruleForm.destinationIds.length === 0 ||
								deriveTierIssues(ruleForm).includes("Critical destinations")
									? "missing"
									: "done"
							}
						>
							<NotificationsSection
								form={ruleForm}
								onChange={setRuleForm}
								destinations={destinations}
								onSendTest={() => void sendTestNotification()}
								testing={sendingTestNotification}
								onAddDestination={
									isAdmin
										? (preset) => destinationManager.openDialog(undefined, preset)
										: undefined
								}
								onQuickCreate={isAdmin ? destinationManager.quickCreate : undefined}
							/>
						</RuleStep>
						<RuleStep
							number={4}
							divider={false}
							title="Name it"
							status={ruleForm.name.trim().length === 0 ? "missing" : "done"}
						>
							<DetailsSection
								form={ruleForm}
								onChange={setRuleForm}
								suggestedName={suggestedName}
								tagSuggestions={tagSuggestions}
							/>
						</RuleStep>
					</div>
				</div>

				<RuleActionBar
					editing={!!editingRule}
					changeCount={editingRule ? changes.length : null}
					saving={savingRule}
					validationIssues={validationIssues}
					summary={describeRuleCondition(ruleForm)}
					onCancel={() => navigate({ to: "/alerts" })}
					onSave={() => void handleSave()}
					onShowTemplates={editingRule ? undefined : () => setTemplatesOpen(true)}
					cancelSlot={
						<Button type="button" variant="outline" render={<Link to="/alerts" />}>
							Cancel
						</Button>
					}
				/>

				<RuleTemplatesOverlay
					open={templatesOpen}
					onOpenChange={setTemplatesOpen}
					onPick={(template) => {
						setRuleForm((current) => {
							const applied = applyTemplate(template, current)
							// Templates fill the query builder; Apdex has no builder aggregation, so it stays Built-in.
							return applied.signalType === "apdex"
								? applied
								: switchSignalKind(applied, "builder_query").form
						})
						setTemplatesOpen(false)
					}}
					onStartBlank={() => setTemplatesOpen(false)}
				/>
			</DashboardPage>
			<DestinationDialog
				open={destinationManager.dialogOpen}
				onOpenChange={destinationManager.setDialogOpen}
				form={destinationManager.form}
				onFormChange={destinationManager.setForm}
				isEditing={destinationManager.isEditing}
				saving={destinationManager.saving}
				onSave={destinationManager.save}
				providerLocked={destinationManager.providerLocked}
				onUnlockProvider={destinationManager.unlockProvider}
			/>
		</>
	)
}

function deriveValidationIssues(form: RuleFormState): string[] {
	const issues: string[] = []
	if (form.name.trim().length === 0) issues.push("Rule name")
	if (!isFilledNumber(form.threshold)) issues.push("Threshold")
	if (isRangeComparator(form.comparator) && !isFilledNumber(form.thresholdUpper)) {
		issues.push("Upper threshold")
	}
	// The timing fields silently fall back to a default when they don't parse
	// (see `parsePositiveNumber` in form-utils), so name them here rather than
	// letting a typo save as a different rule than the one on screen.
	for (const [label, value] of [
		["Window", form.windowMinutes],
		["Checks to fire", form.consecutiveBreachesRequired],
		["Checks to resolve", form.consecutiveHealthyRequired],
		["Remind interval", form.renotifyIntervalMinutes],
	] as const) {
		const parsed = Number(value)
		if (!Number.isFinite(parsed) || parsed <= 0) issues.push(label)
	}
	const minSamples = Number(form.minimumSampleCount)
	if (!Number.isFinite(minSamples) || minSamples < 0) issues.push("Min samples")
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length === 0) {
			issues.push("SQL query")
		} else if (!form.rawQuerySql.includes("$__orgFilter")) {
			issues.push("$__orgFilter in SQL")
		}
	}
	for (const issue of deriveRuleQueryIssues(form)) issues.push(issue)
	for (const issue of deriveTierIssues(form)) issues.push(issue)
	if (form.destinationIds.length === 0) issues.push("Who gets notified")
	return issues
}

/**
 * Identity of the rule *as evaluated*. Derived from the exact payload the test
 * endpoint receives, minus the fields that don't change the verdict (name,
 * notes, tags, destinations, notification template) — so retitling a rule keeps
 * its verdict but retuning the threshold discards it.
 */
function previewIdentityKey(form: RuleFormState): string {
	const {
		name: _name,
		notes: _notes,
		tags: _tags,
		destination_ids: _destinationIds,
		notification_template: _notificationTemplate,
		enabled: _enabled,
		thresholds,
		...evaluated
	} = buildRuleCreateParamsV2(form)
	const tiers = thresholds?.map(({ destination_ids: _ids, ...tier }) => tier)
	return JSON.stringify({ ...evaluated, tiers })
}

function makeSuggestedName(form: RuleFormState): string | null {
	if (form.name.trim().length > 0) return null
	const subject = conditionSubject(form)
	const base = subject.charAt(0).toUpperCase() + subject.slice(1)
	const queryGroupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns?.groupBy
			? (form.queryBuilderDraft.groupBy ?? [])
			: []
	const queryOwnsScope = form.signalType === "builder_query" || form.signalType === "raw_query"
	const scope = queryOwnsScope
		? queryGroupBy.length > 0
			? `per ${queryGroupBy.join(" · ")}`
			: null
		: form.serviceNames.length === 1
			? form.serviceNames[0]!
			: form.serviceNames.length > 1
				? `${form.serviceNames.length} services`
				: form.groupBy.length > 0
					? `per ${form.groupBy.join(" · ")}`
					: null
	const env = !queryOwnsScope && form.environments.length > 0 ? form.environments.join(" · ") : null
	const suffix = [scope, env].filter((part) => part !== null).join(" · ")
	return suffix.length > 0 ? `${base} · ${suffix}` : base
}
