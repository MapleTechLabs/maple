import type { ReactNode } from "react"
import type { V2TraceSamplingPolicy } from "@maple/domain/http/v2"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { ErrorState } from "@/components/common/error-state"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import {
	samplingDraftFromPolicy,
	samplingPatch,
	validateSamplingDraft,
	type SamplingDraft,
} from "./sampling-draft"
import { useSettingsDraft } from "./settings-draft"
import { SettingsSaveBar } from "./settings-save-bar"
import { SettingsSection } from "./settings-section"

const DEFAULT_DRAFT: SamplingDraft = { keepPercent: "100", slowMs: "" }

/**
 * Sampling state for the Ingestion tab. The tab renders the section and the save bar separately,
 * so the bar can sit at the bottom of the whole tab.
 */
export function useSamplingSettings() {
	const queryAtom = retainedQueryV2("traceSampling", "retrieve", {})
	const result = useAtomValue(queryAtom)
	const refresh = useAtomRefresh(queryAtom)
	const update = useAtomSet(MapleApiV2AtomClient.mutation("traceSampling", "update"), {
		mode: "promiseExit",
	})
	const policy = Result.builder(result)
		.onSuccess((v): V2TraceSamplingPolicy | null => v)
		.orElse(() => null)
	const saved = policy === null ? DEFAULT_DRAFT : samplingDraftFromPolicy(policy)
	const form = useSettingsDraft(saved)
	const validation = validateSamplingDraft(form.draft)

	const [save, saving] = useAsyncAction(async () => {
		if (!validation.ok) return
		const submitted = form.submit()
		// Unsent fields keep their saved value, so the parsed draft is still what the server holds.
		const sent = samplingDraftFromPolicy(validation.payload)
		const patch = samplingPatch(validation.payload, saved)
		if (Object.keys(patch).length === 0) return form.commit({ submitted, sent })
		const exit = await update({ payload: patch })
		if (toastExit(exit, { success: "Sampling saved", error: "Failed to save sampling" })) {
			form.commit({ submitted, sent })
			refresh()
		} else form.abort()
	})

	// Switches save on their own; the draft only covers the typed fields.
	const [setKeepErrors, togglingErrors] = useAsyncAction(async (next: boolean) => {
		const exit = await update({ payload: { always_keep_error_spans: next } })
		if (toastExit(exit, { error: "Failed to update sampling" })) refresh()
	})

	return { result, policy, form, validation, save, saving, setKeepErrors, togglingErrors, refresh }
}

export type SamplingSettings = ReturnType<typeof useSamplingSettings>

export function SamplingSaveBar({ sampling }: { sampling: SamplingSettings }) {
	return (
		<SettingsSaveBar
			dirty={sampling.form.isDirty}
			pending={sampling.saving}
			context="Sampling"
			onDiscard={sampling.form.discard}
			onSave={() => void sampling.save()}
			saveDisabled={!sampling.validation.ok}
		/>
	)
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="flex min-h-14 items-center justify-between gap-4 px-4 py-2.5">
			<div className="flex min-w-0 items-baseline gap-2">
				<span className="text-sm">{label}</span>
				{hint ? <span className="text-muted-foreground text-2xs">{hint}</span> : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	)
}

function UnitInput({
	label,
	unit,
	value,
	invalid,
	placeholder,
	onChange,
}: {
	label: string
	unit: string
	value: string
	invalid: boolean
	placeholder?: string
	onChange: (value: string) => void
}) {
	return (
		<InputGroup className="w-32">
			<InputGroupInput
				aria-label={label}
				aria-invalid={invalid || undefined}
				inputMode="decimal"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="font-mono tabular-nums"
			/>
			<InputGroupAddon align="inline-end">
				<InputGroupText>{unit}</InputGroupText>
			</InputGroupAddon>
		</InputGroup>
	)
}

export function SamplingSection({ sampling }: { sampling: SamplingSettings }) {
	const isAdmin = useIsOrgAdmin()
	const { result, policy, form, validation } = sampling
	const errors = validation.ok ? {} : validation.errors

	return (
		<SettingsSection
			anchorId="sampling"
			title="Sampling"
			description="Maple keeps a share of traces at the ingest gateway. Error and slow spans can always be kept."
			padded={false}
		>
			{Result.isInitial(result) ? (
				<div className="space-y-3 p-4">
					<Skeleton className="h-5 w-full" />
					<Skeleton className="h-5 w-full" />
				</div>
			) : policy === null ? (
				<ErrorState
					error={Result.isFailure(result) ? result.cause : undefined}
					title="Couldn't load sampling"
					onRetry={sampling.refresh}
					className="border-0"
				/>
			) : (
				<div className="divide-y">
					<Row label="Keep traces">
						{isAdmin ? (
							<UnitInput
								label="Keep traces, percent"
								unit="%"
								value={form.draft.keepPercent}
								invalid={errors.keepPercent !== undefined}
								onChange={(keepPercent) => form.updateDraft((d) => ({ ...d, keepPercent }))}
							/>
						) : (
							<span className="font-mono text-sm">{form.draft.keepPercent}%</span>
						)}
					</Row>
					<Row label="Always keep error spans">
						{isAdmin ? (
							<Switch
								aria-label="Always keep error spans"
								checked={policy.always_keep_error_spans}
								disabled={sampling.togglingErrors}
								onCheckedChange={(next) => void sampling.setKeepErrors(next)}
							/>
						) : (
							<span className="text-sm">{policy.always_keep_error_spans ? "On" : "Off"}</span>
						)}
					</Row>
					<Row label="Always keep spans slower than" hint="Optional">
						{isAdmin ? (
							<UnitInput
								label="Always keep spans slower than, milliseconds"
								unit="ms"
								placeholder="Off"
								value={form.draft.slowMs}
								invalid={errors.slowMs !== undefined}
								onChange={(slowMs) => form.updateDraft((d) => ({ ...d, slowMs }))}
							/>
						) : (
							<span className="font-mono text-sm">
								{policy.always_keep_slow_spans_ms === null
									? "Off"
									: `${policy.always_keep_slow_spans_ms} ms`}
							</span>
						)}
					</Row>
					{errors.keepPercent || errors.slowMs ? (
						<p role="alert" className="text-destructive-foreground px-4 py-2.5 text-xs">
							{errors.keepPercent ?? errors.slowMs}
						</p>
					) : null}
					<p className="text-muted-foreground px-4 py-2.5 text-2xs">
						Span counts and throughput are scaled up while sampling is on. Changes reach the
						gateway within about 30 seconds.
					</p>
				</div>
			)}
		</SettingsSection>
	)
}
