import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatNumber } from "@maple/ui/lib/format"

import { Badge } from "@maple/ui/components/ui/badge"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { Field, FieldDescription, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { Meter } from "@maple/ui/components/ui/meter"
import { Panel } from "@maple/ui/components/ui/panel"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { type AiTriageSettingsDocument, AiTriageSettingsUpdateRequest } from "@maple/domain/http"
import { ChevronRightIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { SettingsSaveBar } from "@/components/settings/settings-save-bar"
import { SettingsSection } from "@/components/settings/settings-section"
import { useSettingsDraft } from "@/components/settings/settings-draft"
import {
	type AiTriageLimitsDraft,
	limitsUpdate,
	PASSES_PER_DAY_LIMITS,
	parseDailyLimit,
	RUNS_PER_DAY_LIMITS,
} from "@/components/settings/ai-triage-limits"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"

const SETTINGS_REACTIVITY_KEYS = ["aiTriageSettings"]

const DESCRIPTION =
	"When an error or anomaly incident opens, an agent investigates it with read-only tools and attaches a triage summary. Runs on the model provider above."

/**
 * Auto-triage on the AI tab: the switch saves at once, the two ceilings go through the save bar.
 * Orgs outside the rollout see the same rows disabled, marked as coming soon.
 */
export function AutoTriageSection({ available }: { available: boolean }) {
	if (!available) return <AutoTriageTeaser />
	return <AutoTriageSettings />
}

function AutoTriageTeaser() {
	return (
		<SettingsSection
			title="Auto-triage"
			description={DESCRIPTION}
			actions={<Badge variant="muted">Coming soon</Badge>}
			framed={false}
		>
			<Panel className="divide-y">
				<SettingRow
					className="p-4 opacity-60"
					label="Investigate new incidents"
					description="Not yet available for your organization."
					control={<Switch checked={false} disabled />}
				/>
				<SettingRow
					className="p-4 opacity-60"
					label="Investigations per day"
					description="Per UTC day. Investigations you start or retry yourself are never blocked."
					control={
						<Input
							className="w-48"
							disabled
							value=""
							readOnly
							aria-label="Investigations per day"
						/>
					}
				/>
			</Panel>
		</SettingsSection>
	)
}

function AutoTriageSettings() {
	const settingsQueryAtom = retainedInternalQuery("aiTriage", "getSettings", {
		reactivityKeys: SETTINGS_REACTIVITY_KEYS,
	})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	return (
		<SettingsSection title="Auto-triage" description={DESCRIPTION} framed={false}>
			{Result.builder(settingsResult)
				.onInitial(() => <Skeleton className="h-40 w-full" />)
				.onError((error) => (
					<ErrorState
						error={error}
						title="Failed to load auto-triage settings"
						variant="row"
						onRetry={() => refreshSettings()}
					/>
				))
				.onSuccess((current) => <AutoTriageForm current={current} />)
				.render()}
		</SettingsSection>
	)
}

function AutoTriageForm({ current }: { current: AiTriageSettingsDocument }) {
	const updateMutation = useAtomSet(MapleInternalAtomClient.mutation("aiTriage", "updateSettings"), {
		mode: "promiseExit",
	})
	const saved: AiTriageLimitsDraft = {
		maxRunsPerDay: String(current.maxRunsPerDay),
		maxPassesPerDay: String(current.maxPassesPerDay),
	}
	const { draft, isDirty, updateDraft, discard, commit, submit, abort } = useSettingsDraft(saved)

	const send = async (request: AiTriageSettingsUpdateRequest, success: string) =>
		toastExit(await updateMutation({ payload: request, reactivityKeys: SETTINGS_REACTIVITY_KEYS }), {
			success,
			error: "Failed to update auto-triage settings",
		})

	const [toggle, isToggling] = useAsyncAction((enabled: boolean) =>
		send(
			new AiTriageSettingsUpdateRequest({ enabled }),
			enabled ? "Auto-triage turned on" : "Auto-triage turned off",
		),
	)

	const update = limitsUpdate(draft, current)
	const [saveLimits, isSavingLimits] = useAsyncAction(async () => {
		if (!update.ok) return
		const submitted = submit()
		const request = new AiTriageSettingsUpdateRequest({
			...(update.maxRunsPerDay === null ? undefined : { maxRunsPerDay: update.maxRunsPerDay }),
			...(update.maxPassesPerDay === null ? undefined : { maxPassesPerDay: update.maxPassesPerDay }),
		})
		const sent: AiTriageLimitsDraft = {
			maxRunsPerDay: String(update.maxRunsPerDay ?? current.maxRunsPerDay),
			maxPassesPerDay: String(update.maxPassesPerDay ?? current.maxPassesPerDay),
		}
		if (await send(request, "Auto-triage limits saved")) commit({ submitted, sent })
		else abort()
	})

	const runsError = parseDailyLimit(draft.maxRunsPerDay, RUNS_PER_DAY_LIMITS)
	const passesError = parseDailyLimit(draft.maxPassesPerDay, PASSES_PER_DAY_LIMITS)

	return (
		<>
			<Panel className="divide-y">
				<SettingRow
					className="p-4"
					label="Investigate new incidents"
					description="Applies right away."
					control={
						<Switch
							checked={current.enabled}
							disabled={isToggling}
							onCheckedChange={(checked) => toggle(checked)}
						/>
					}
				/>
				<LimitRow
					id="ai-triage-max-runs"
					label="Investigations per day"
					help="Per UTC day. Investigations you start or retry yourself are never blocked."
					value={draft.maxRunsPerDay}
					error={runsError.ok ? null : runsError.message}
					limit={current.maxRunsPerDay}
					spent={current.usage.runs}
					disabled={isSavingLimits}
					onChange={(maxRunsPerDay) => updateDraft((d) => ({ ...d, maxRunsPerDay }))}
				/>
				<Collapsible defaultOpen={!passesError.ok}>
					<CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left">
						<ChevronRightIcon
							size={14}
							className="shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
						/>
						<span className="text-xs font-medium text-foreground">Advanced limits</span>
						<span className="truncate text-2xs text-muted-foreground">
							Model passes per day, reserve for high and critical incidents
						</span>
					</CollapsibleTrigger>
					<CollapsiblePanel>
						<LimitRow
							id="ai-triage-max-passes"
							label="Model passes per day"
							help="The spend ceiling. An investigation is one model pass. Three tenths of it is reserved for high and critical incidents."
							value={draft.maxPassesPerDay}
							error={passesError.ok ? null : passesError.message}
							limit={current.maxPassesPerDay}
							spent={current.usage.passes}
							disabled={isSavingLimits}
							onChange={(maxPassesPerDay) => updateDraft((d) => ({ ...d, maxPassesPerDay }))}
						/>
					</CollapsiblePanel>
				</Collapsible>
			</Panel>
			<SettingsSaveBar
				dirty={isDirty}
				pending={isSavingLimits}
				onDiscard={discard}
				onSave={() => saveLimits()}
				saveDisabled={!update.ok}
			/>
		</>
	)
}

/** A daily ceiling with today's consumption under it, so it is clear whether it is about to bite. */
function LimitRow({
	id,
	label,
	help,
	value,
	error,
	limit,
	spent,
	disabled,
	onChange,
}: {
	id: string
	label: string
	help: string
	value: string
	error: string | null
	limit: number
	spent: number
	disabled: boolean
	onChange: (next: string) => void
}) {
	return (
		<Field invalid={error !== null} className="flex-row items-start justify-between gap-6 p-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<FieldLabel htmlFor={id}>{label}</FieldLabel>
				<FieldDescription className="max-w-sm leading-relaxed">{help}</FieldDescription>
			</div>
			<div className="flex w-48 shrink-0 flex-col gap-2">
				<Input
					id={id}
					inputMode="numeric"
					value={value}
					disabled={disabled}
					aria-invalid={error !== null}
					onChange={(event) => onChange(event.target.value)}
				/>
				{error === null ? (
					<>
						<Meter value={spent} max={limit} label={`${label} used today`} />
						<span className="font-mono text-2xs text-muted-foreground">
							{formatNumber(spent)} used today
						</span>
					</>
				) : (
					<FieldError match>{error}</FieldError>
				)}
			</div>
		</Field>
	)
}
