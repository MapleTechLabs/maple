import { useMemo } from "react"
import { Exit } from "effect"
import { useOrganization, useUser } from "@clerk/clerk-react"
import { type DigestSubscriptionResponse, UpsertDigestSubscriptionRequest } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"

import { Button } from "@maple/ui/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Panel } from "@maple/ui/components/ui/panel"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { ChartBarTrendUpIcon, EnvelopeIcon } from "@/components/icons"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { readDigestSubscription } from "@/components/account/digest-subscription-load"
import {
	DIGEST_DAYS,
	DIGEST_HOURS,
	type DigestPreferencesDraft,
	digestTimeZoneOptions,
	newDigestDraft,
	sameDigestDraft,
} from "@/components/account/digest-preferences"
import { ErrorState } from "@/components/common/error-state"
import { SettingsSaveBar } from "@/components/settings/settings-save-bar"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { useSettingsDraft } from "@/components/settings/settings-draft"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { snapRangeForCache } from "@/lib/time-utils"

const TITLE = "Email preferences"

/** The weekly digests this user gets for the active organization. */
export function EmailPreferencesSection() {
	const { user } = useUser()
	const { organization } = useOrganization()
	const email = user?.primaryEmailAddress?.emailAddress

	const subscriptionQueryAtom = retainedInternalQuery("digest", "getSubscription", {})
	const subscriptionResult = useAtomValue(subscriptionQueryAtom)
	const refreshSubscription = useAtomRefresh(subscriptionQueryAtom)
	const load = readDigestSubscription(subscriptionResult)

	if (load.status === "loading" || !user) return <AccountSectionSkeleton />

	const recipient = email ? (
		<>
			Sent to <span className="text-foreground">{email}</span>
			{organization ? ` for ${organization.name}` : null}
		</>
	) : (
		"Add a primary email address to receive digests."
	)

	return (
		<SettingsSections>
			<SettingsSection title={TITLE} description={recipient} framed={false}>
				{/* Switches built on defaults would upsert over preferences we could not read. */}
				{load.status === "failed" ? (
					<ErrorState
						variant="row"
						error={load.cause}
						title="Couldn't load your email preferences"
						onRetry={refreshSubscription}
					/>
				) : (
					<DigestPreferences saved={load.saved} email={email} onSaved={refreshSubscription} />
				)}
				<p className="text-xs text-muted-foreground">
					Unsubscribe links in each email turn the matching digest off.
				</p>
			</SettingsSection>
		</SettingsSections>
	)
}

const browserTimeZone = (): string | undefined => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The saved schedule and scope, or the defaults in the browser's zone for someone who never saved. */
const savedDraft = (saved: DigestSubscriptionResponse | null): DigestPreferencesDraft =>
	saved === null
		? newDigestDraft(browserTimeZone())
		: {
				dayOfWeek: saved.dayOfWeek,
				sendHour: saved.sendHour,
				timezone: saved.timezone,
				namespaces: saved.namespaces,
				environments: saved.environments,
			}

function DigestPreferences({
	saved,
	email,
	onSaved,
}: {
	saved: DigestSubscriptionResponse | null
	email: string | undefined
	onSaved: () => void
}) {
	const upsertMutation = useAtomSet(MapleInternalAtomClient.mutation("digest", "upsertSubscription"), {
		mode: "promiseExit",
	})
	const enabled = saved?.enabled ?? true
	const webAnalyticsEnabled = saved?.webAnalyticsEnabled ?? true
	const baseline = savedDraft(saved)
	const { draft, isDirty, updateDraft, discard, commit, submit, abort } = useSettingsDraft(
		baseline,
		sameDigestDraft,
	)
	// The first write records the prefilled zone, so a toggle alone does not leave the row on UTC.
	const firstWrite = saved === null ? { timezone: baseline.timezone } : {}

	// `enabled` always rides along: the upsert treats a missing value as "on".
	const upsert = async (
		fields: Omit<UpsertDigestSubscriptionRequest, "email" | "enabled">,
		next: { enabled: boolean },
		messages: { success: string; error: string },
	) => {
		if (!email) return false
		const exit = await upsertMutation({
			payload: new UpsertDigestSubscriptionRequest({ email, enabled: next.enabled, ...fields }),
		})
		const ok = toastExit(exit, messages)
		if (ok) onSaved()
		return ok
	}

	const [toggleOps, isTogglingOps] = useAsyncAction((checked: boolean) =>
		upsert(
			firstWrite,
			{ enabled: checked },
			{
				success: checked ? "Weekly ops digest turned on" : "Weekly ops digest turned off",
				error: "Failed to update the weekly ops digest",
			},
		),
	)
	const [toggleWeb, isTogglingWeb] = useAsyncAction((checked: boolean) =>
		upsert(
			{ ...firstWrite, webAnalyticsEnabled: checked },
			{ enabled },
			{
				success: checked ? "Web analytics digest turned on" : "Web analytics digest turned off",
				error: "Failed to update the web analytics digest",
			},
		),
	)
	const [save, isSaving] = useAsyncAction(async () => {
		const submitted = submit()
		const ok = await upsert(
			{
				dayOfWeek: draft.dayOfWeek,
				sendHour: draft.sendHour,
				timezone: draft.timezone,
				namespaces: draft.namespaces,
				environments: draft.environments,
			},
			{ enabled },
			{ success: "Email preferences saved", error: "Failed to save email preferences" },
		)
		if (ok) commit({ submitted })
		else abort()
	})

	const busy = isTogglingOps || isTogglingWeb || isSaving
	const schedule = (
		<ScheduleField
			draft={draft}
			disabled={isSaving}
			onChange={(patch) => updateDraft((current) => ({ ...current, ...patch }))}
		/>
	)

	return (
		<>
			<Panel className="divide-y">
				<SettingRow
					className="p-4"
					icon={<EnvelopeIcon size={18} className="text-muted-foreground" />}
					label="Weekly ops digest"
					description="Errors, latency, alerts and ingest volume for the past week."
					control={
						<Switch
							checked={enabled}
							disabled={busy || !email}
							onCheckedChange={(checked) => toggleOps(checked)}
						/>
					}
				>
					{enabled ? (
						<Panel tone="muted" padded className="gap-4">
							{schedule}
							<ScopeFields
								draft={draft}
								disabled={isSaving}
								onChange={(patch) => updateDraft((current) => ({ ...current, ...patch }))}
							/>
							<PreviewButton kind="ops" disabled={busy} />
						</Panel>
					) : null}
				</SettingRow>
				<SettingRow
					className="p-4"
					icon={<ChartBarTrendUpIcon size={18} className="text-muted-foreground" />}
					label="Web analytics digest"
					description="Weekly overview of visitors, top pages and AI traffic. Only sent once the browser SDK is reporting visits."
					control={
						<>
							<PreviewButton kind="web" disabled={busy} />
							<Switch
								checked={webAnalyticsEnabled}
								disabled={busy || !email}
								onCheckedChange={(checked) => toggleWeb(checked)}
							/>
						</>
					}
				>
					{/* Both digests share one schedule; it lives here only while the ops digest is off. */}
					{!enabled && webAnalyticsEnabled ? (
						<Panel tone="muted" padded>
							{schedule}
						</Panel>
					) : null}
				</SettingRow>
			</Panel>
			<SettingsSaveBar dirty={isDirty} pending={isSaving} onDiscard={discard} onSave={() => save()} />
		</>
	)
}

type DraftPatch = Partial<DigestPreferencesDraft>

/** "Every <day> at <hour> <zone>", on the subscriber's own clock. */
function ScheduleField({
	draft,
	disabled,
	onChange,
}: {
	draft: DigestPreferencesDraft
	disabled: boolean
	onChange: (patch: DraftPatch) => void
}) {
	const zones = useMemo(
		() => digestTimeZoneOptions(Intl.supportedValuesOf("timeZone"), draft.timezone, browserTimeZone()),
		[draft.timezone],
	)
	return (
		<Field>
			<FieldLabel htmlFor="digest-day">Schedule</FieldLabel>
			<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				<span>Every</span>
				<NativeSelect
					id="digest-day"
					aria-label="Day"
					className="w-32"
					value={String(draft.dayOfWeek)}
					disabled={disabled}
					onChange={(event) => onChange({ dayOfWeek: Number(event.target.value) })}
				>
					{DIGEST_DAYS.map((day) => (
						<NativeSelectOption key={day.value} value={day.value}>
							{day.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<span>at</span>
				<NativeSelect
					aria-label="Time"
					className="w-24"
					value={String(draft.sendHour)}
					disabled={disabled}
					onChange={(event) => onChange({ sendHour: Number(event.target.value) })}
				>
					{DIGEST_HOURS.map((hour) => (
						<NativeSelectOption key={hour.value} value={hour.value}>
							{hour.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<NativeSelect
					aria-label="Time zone"
					className="w-48"
					value={draft.timezone}
					disabled={disabled}
					onChange={(event) => onChange({ timezone: event.target.value })}
				>
					{zones.map((zone) => (
						<NativeSelectOption key={zone} value={zone}>
							{zone}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			<FieldDescription>Sent in your time zone. Both digests follow this schedule.</FieldDescription>
			<p className="text-xs text-muted-foreground">
				Changes apply from the next send, so moving the day right after a digest went out skips to
				next week.
			</p>
		</Field>
	)
}

function ScopeFields({
	draft,
	disabled,
	onChange,
}: {
	draft: DigestPreferencesDraft
	disabled: boolean
	onChange: (patch: DraftPatch) => void
}) {
	// The same snapped 24h probe the overview, service map and namespace switcher run, so this
	// shares their cache entry rather than adding a request.
	const facetsRange = useMemo(() => {
		const end = Date.now()
		return snapRangeForCache({
			startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(end),
		})
	}, [])
	const facetsResult = useAtomValue(getServicesFacetsResultAtom({ data: facetsRange }))
	const facets = Result.isSuccess(facetsResult)
		? facetsResult.value.data
		: { environments: [], namespaces: [] }

	// The facets carry an empty-string entry for "not reported", which a digest cannot pin to.
	const namespaceOptions = useMemo(
		() => facets.namespaces.filter((item) => item.name !== "").map((item) => ({ value: item.name })),
		[facets.namespaces],
	)
	const environmentOptions = useMemo(
		() => facets.environments.filter((item) => item.name !== "").map((item) => ({ value: item.name })),
		[facets.environments],
	)

	return (
		<>
			<Field disabled={disabled}>
				<FieldLabel htmlFor="digest-namespaces">Namespaces</FieldLabel>
				<MultiSelectCombobox
					id="digest-namespaces"
					className="sm:max-w-xs"
					emptyMessage="No namespaces detected."
					options={namespaceOptions}
					value={draft.namespaces}
					onChange={(namespaces) => onChange({ namespaces })}
					placeholder={draft.namespaces.length === 0 ? "All namespaces" : "Add namespace..."}
				/>
				<FieldDescription>Leave empty to cover every namespace.</FieldDescription>
			</Field>
			<Field disabled={disabled}>
				<FieldLabel htmlFor="digest-environments">Environments</FieldLabel>
				<MultiSelectCombobox
					id="digest-environments"
					className="sm:max-w-xs"
					emptyMessage="No environments detected."
					options={environmentOptions}
					value={draft.environments}
					onChange={(environments) => onChange({ environments })}
					placeholder={draft.environments.length === 0 ? "All environments" : "Add environment..."}
				/>
				<FieldDescription>Leave empty to cover every environment.</FieldDescription>
			</Field>
		</>
	)
}

/**
 * The email HTML carries org data (page paths, referrers, names), so it never runs on the app's
 * origin: it renders in a sandboxed iframe with no scripts and an opaque origin. Popups stay
 * allowed so the email's links still open.
 */
function openPreview(html: string) {
	const win = window.open("", "_blank")
	if (!win) return
	win.opener = null
	const doc = win.document
	doc.title = "Email preview"
	doc.body.style.margin = "0"
	const frame = doc.createElement("iframe")
	frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox")
	frame.srcdoc = html
	frame.style.cssText = "border:0;width:100vw;height:100vh;display:block"
	doc.body.append(frame)
}

function PreviewButton({ kind, disabled }: { kind: "ops" | "web"; disabled: boolean }) {
	const previewOps = useAtomSet(MapleInternalAtomClient.mutation("digest", "preview"), {
		mode: "promiseExit",
	})
	const previewWeb = useAtomSet(MapleInternalAtomClient.mutation("digest", "previewWebAnalytics"), {
		mode: "promiseExit",
	})
	const [preview, isPreviewing] = useAsyncAction(async () => {
		const exit = await (kind === "ops" ? previewOps({}) : previewWeb({}))
		if (toastExit(exit, { error: "Failed to generate the preview" }) && Exit.isSuccess(exit))
			openPreview(exit.value.html)
	})
	return (
		<Button
			variant="outline"
			size="sm"
			className="w-fit"
			loading={isPreviewing}
			disabled={disabled}
			onClick={() => preview()}
		>
			Preview
		</Button>
	)
}
