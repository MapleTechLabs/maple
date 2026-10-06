import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { useState } from "react"
import { formatNumber } from "@maple/ui/lib/format"

import { Badge } from "@maple/ui/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Panel } from "@maple/ui/components/ui/panel"
import { RefreshButton } from "@maple/ui/components/ui/refresh-button"
import { Input } from "@maple/ui/components/ui/input"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { AiTriageSettingsUpdateRequest } from "@maple/domain/http"
import { ErrorState } from "@/components/common/error-state"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"

interface AiTriageSettingsSectionProps {
	isAdmin: boolean
	hasEntitlement: boolean
}

const SETTINGS_REACTIVITY_KEYS = ["aiTriageSettings"]

/**
 * A number field that commits on blur and only when the value actually changed.
 *
 * Shared by both ceilings rather than written twice: the draft state, the parse,
 * the range guard and the no-op check are the same six lines, and the second copy
 * is where the two fields drift apart.
 */
function DailyLimitField({
	id,
	label,
	value,
	min,
	max,
	disabled,
	help,
	spent,
	onCommit,
}: {
	id: string
	label: string
	value: number
	min: number
	max: number
	disabled: boolean
	help: React.ReactNode
	/** Consumed so far today. A ceiling on its own does not say whether it is about to bite. */
	spent: number
	onCommit: (next: number) => void
}) {
	const [draft, setDraft] = useState<string | null>(null)
	return (
		<Field className="sm:max-w-xs">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type="number"
				min={min}
				max={max}
				disabled={disabled}
				value={draft ?? String(value)}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (draft === null) return
					const parsed = Number.parseInt(draft, 10)
					setDraft(null)
					if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) {
						onCommit(parsed)
					}
				}}
			/>
			<FieldDescription>
				<span className="text-foreground">
					{formatNumber(spent)} of {formatNumber(value)} used today
				</span>{" "}
				· {help}
			</FieldDescription>
		</Field>
	)
}

export function AiTriageSettingsSection({ isAdmin, hasEntitlement }: AiTriageSettingsSectionProps) {
	const settingsQueryAtom = retainedInternalQuery("aiTriage", "getSettings", {
		reactivityKeys: SETTINGS_REACTIVITY_KEYS,
	})
	const settingsResult = useAtomValue(settingsQueryAtom)
	const refreshSettings = useAtomRefresh(settingsQueryAtom)

	const updateMutation = useAtomSet(MapleInternalAtomClient.mutation("aiTriage", "updateSettings"), {
		mode: "promiseExit",
	})

	const [save, isSaving] = useAsyncAction(
		async (request: AiTriageSettingsUpdateRequest, successMessage: string) => {
			const result = await updateMutation({
				payload: request,
				reactivityKeys: SETTINGS_REACTIVITY_KEYS,
			})
			toastExit(result, { success: successMessage, error: "Failed to update AI triage settings" })
		},
	)

	if (!isAdmin || !hasEntitlement) {
		return null
	}

	const settings = Result.builder(settingsResult)
		.onSuccess((value) => value)
		.orElse(() => null)

	return (
		<Panel padded className="gap-6">
			<div className="space-y-1">
				<h3 className="flex items-center gap-2 text-sm font-medium">
					AI auto-triage
					{settings?.enabled ? <Badge variant="ok">Enabled</Badge> : null}
				</h3>
				<p className="text-sm text-muted-foreground">
					When a new error or anomaly incident opens, an AI agent automatically investigates it with
					read-only tools and attaches a triage summary. Runs use Maple's managed AI, no setup
					required.
				</p>
			</div>
			{Result.builder(settingsResult)
				.onInitial(() => <Skeleton className="h-24 w-full" />)
				.onError((error) => (
					<ErrorState
						error={error}
						title="Failed to load AI triage settings"
						variant="row"
						onRetry={() => refreshSettings()}
					/>
				))
				.onSuccess((current) => (
					<>
						<SettingRow
							label="Auto-triage new incidents"
							description="Investigate each new incident automatically."
							control={
								<Switch
									checked={current.enabled}
									disabled={isSaving}
									onCheckedChange={(checked) =>
										save(
											new AiTriageSettingsUpdateRequest({ enabled: checked }),
											checked ? "AI auto-triage enabled" : "AI auto-triage disabled",
										)
									}
								/>
							}
						/>

						<DailyLimitField
							id="ai-triage-max-runs"
							label="Max investigations per day"
							value={current.maxRunsPerDay}
							min={1}
							max={500}
							disabled={isSaving}
							spent={current.usage.runs}
							help="How many incidents auto-triage may investigate in a UTC day."
							onCommit={(parsed) =>
								save(
									new AiTriageSettingsUpdateRequest({ maxRunsPerDay: parsed }),
									"Daily run cap updated",
								)
							}
						/>

						<DailyLimitField
							id="ai-triage-max-passes"
							label="Max model passes per day"
							value={current.maxPassesPerDay}
							min={1}
							max={2000}
							disabled={isSaving}
							spent={current.usage.passes}
							help="The spend ceiling. An investigation is one model pass, so this and the run ceiling count the same thing. Three tenths of it is reserved for high and critical incidents."
							onCommit={(parsed) =>
								save(
									new AiTriageSettingsUpdateRequest({ maxPassesPerDay: parsed }),
									"Daily model-pass cap updated",
								)
							}
						/>

						<p className="text-xs text-muted-foreground">
							Both ceilings apply to automatic triage only. Investigations you start or retry
							yourself are never blocked by them.
						</p>

						<div className="flex justify-end">
							<RefreshButton
								variant="ghost"
								disabled={isSaving}
								pending={settingsResult.waiting}
								onRefresh={() => refreshSettings()}
							/>
						</div>
					</>
				))
				.render()}
		</Panel>
	)
}
