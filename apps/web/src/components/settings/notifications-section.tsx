import { useMemo, useState } from "react"
import { Exit } from "effect"
import { Field, FieldLabel, FieldDescription } from "@maple/ui/components/ui/field"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { UpsertDigestSubscriptionRequest } from "@maple/domain/http"
import { useUser } from "@clerk/clerk-react"
import { formatWarehouseDateTime } from "@maple/query-engine"

import { Button } from "@maple/ui/components/ui/button"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"
import { Panel } from "@maple/ui/components/ui/panel"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { ChartBarTrendUpIcon, EnvelopeIcon } from "@/components/icons"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { snapRangeForCache } from "@/lib/time-utils"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"

/** Two arrays are the same scope regardless of the order they were picked in. */
const sameScope = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index])

interface DigestSave {
	enabled: boolean
	environments: string[]
	namespaces: string[]
	webAnalyticsEnabled?: boolean
}

export function NotificationsSection() {
	const { user } = useUser()
	const email = user?.primaryEmailAddress?.emailAddress

	const subscriptionQueryAtom = retainedInternalQuery("digest", "getSubscription", {})
	const subscriptionResult = useAtomValue(subscriptionQueryAtom)
	const refreshSubscription = useAtomRefresh(subscriptionQueryAtom)

	const upsertMutation = useAtomSet(MapleInternalAtomClient.mutation("digest", "upsertSubscription"), {
		mode: "promiseExit",
	})

	// The saved subscription is the source of truth; local state holds only the
	// edits made since it loaded. Derived rather than copied in an effect, so a
	// refresh after a save is reflected instead of being locked out by an
	// "initialized" flag.
	const saved = Result.isSuccess(subscriptionResult) ? subscriptionResult.value : null
	const settled = !Result.isInitial(subscriptionResult)

	const [enabledEdit, setEnabledEdit] = useState<boolean | null>(null)
	const [webAnalyticsEdit, setWebAnalyticsEdit] = useState<boolean | null>(null)
	const [scopeEdit, setScopeEdit] = useState<{ environments: string[]; namespaces: string[] } | null>(null)

	const enabled = enabledEdit ?? saved?.enabled ?? true
	const webAnalyticsEnabled = webAnalyticsEdit ?? saved?.webAnalyticsEnabled ?? true
	const savedScope = {
		environments: saved ? [...saved.environments] : [],
		namespaces: saved ? [...saved.namespaces] : [],
	}
	const environments = scopeEdit?.environments ?? savedScope.environments
	const namespaces = scopeEdit?.namespaces ?? savedScope.namespaces

	const setEnvironments = (values: string[]) => setScopeEdit({ environments: values, namespaces })
	const setNamespaces = (values: string[]) => setScopeEdit({ environments, namespaces: values })

	const previewMutation = useAtomSet(MapleInternalAtomClient.mutation("digest", "preview"), {
		mode: "promiseExit",
	})
	const previewWebAnalyticsMutation = useAtomSet(
		MapleInternalAtomClient.mutation("digest", "previewWebAnalytics"),
		{ mode: "promiseExit" },
	)

	// The same snapped 24h probe the overview, service map and namespace switcher
	// run, so this shares their cache entry rather than adding a request.
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

	// The facets carry an empty-string entry for "not reported", which is not
	// something a subscriber can meaningfully pin a digest to.
	const environmentOptions = useMemo(
		() => facets.environments.filter((item) => item.name !== "").map((item) => ({ value: item.name })),
		[facets.environments],
	)
	const namespaceOptions = useMemo(
		() => facets.namespaces.filter((item) => item.name !== "").map((item) => ({ value: item.name })),
		[facets.namespaces],
	)

	const scopeDirty =
		!sameScope(environments, savedScope.environments) || !sameScope(namespaces, savedScope.namespaces)

	const [save, isSaving] = useAsyncAction(
		async (next: DigestSave, messages: { success: string; error: string }) => {
			if (!email) return false
			const result = await upsertMutation({
				payload: new UpsertDigestSubscriptionRequest({
					email,
					enabled: next.enabled,
					environments: next.environments,
					namespaces: next.namespaces,
					// The saved value when this save is not about it, so the ops digest's
					// controls never flip the web analytics email.
					webAnalyticsEnabled: next.webAnalyticsEnabled ?? webAnalyticsEnabled,
				}),
			})
			if (!toastExit(result, messages)) return false
			// Drop the local edits; the refreshed subscription now carries them.
			setEnabledEdit(null)
			setWebAnalyticsEdit(null)
			setScopeEdit(null)
			refreshSubscription()
			return true
		},
	)

	async function handleToggle(checked: boolean) {
		setEnabledEdit(checked)
		const ok = await save(
			{ enabled: checked, environments, namespaces },
			{
				success: checked ? "Weekly digest enabled" : "Weekly digest disabled",
				error: "Failed to update notification preferences",
			},
		)
		if (!ok) setEnabledEdit(!checked)
	}

	async function handleWebAnalyticsToggle(checked: boolean) {
		setWebAnalyticsEdit(checked)
		// `enabled` rides along: the upsert treats a missing value as "on".
		const ok = await save(
			{ enabled, environments, namespaces, webAnalyticsEnabled: checked },
			{
				success: checked ? "Web analytics email enabled" : "Web analytics email disabled",
				error: "Failed to update notification preferences",
			},
		)
		if (!ok) setWebAnalyticsEdit(!checked)
	}

	function handleSaveScope() {
		return save(
			{ enabled, environments, namespaces },
			{ success: "Digest scope updated", error: "Failed to update digest scope" },
		)
	}

	/**
	 * The email HTML carries org data (page paths, referrers, names), so it never
	 * runs on the app's origin: it renders in a sandboxed iframe with no scripts
	 * and an opaque origin. Popups stay allowed so the email's links still open.
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

	const [handlePreview, isPreviewing] = useAsyncAction(async () => {
		const result = await previewMutation({})
		if (toastExit(result, { error: "Failed to generate digest preview" }) && Exit.isSuccess(result))
			openPreview(result.value.html)
	})

	const [handlePreviewWebAnalytics, isPreviewingWebAnalytics] = useAsyncAction(async () => {
		const result = await previewWebAnalyticsMutation({})
		if (
			toastExit(result, { error: "Failed to generate web analytics preview" }) &&
			Exit.isSuccess(result)
		)
			openPreview(result.value.html)
	})

	if (!settled || !user) return <AccountSectionSkeleton />

	return (
		<SettingsSections>
			<SettingsSection title="Weekly digests" padded={false}>
				<div className="divide-y">
					<SettingRow
						className="p-4"
						active={enabled}
						icon={<EnvelopeIcon size={18} className="text-muted-foreground" />}
						label="Email"
						description="Weekly digest via email"
						control={
							<Switch
								checked={enabled}
								onCheckedChange={handleToggle}
								disabled={isSaving || !email}
							/>
						}
					>
						{enabled && (
							<Panel tone="muted" padded className="gap-4">
								<Field>
									<FieldLabel htmlFor="digest-namespaces">Namespaces</FieldLabel>
									<MultiSelectCombobox
										id="digest-namespaces"
										emptyMessage="No namespaces detected."
										options={namespaceOptions}
										value={namespaces}
										onChange={setNamespaces}
										placeholder={
											namespaces.length === 0 ? "All namespaces" : "Add namespace…"
										}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="digest-environments">Environments</FieldLabel>
									<MultiSelectCombobox
										id="digest-environments"
										emptyMessage="No environments detected."
										options={environmentOptions}
										value={environments}
										onChange={setEnvironments}
										placeholder={
											environments.length === 0
												? "All environments"
												: "Add environment…"
										}
									/>
									<FieldDescription>
										Leave both empty to receive a digest covering the whole organization.
									</FieldDescription>
								</Field>
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={handlePreview}
										loading={isPreviewing}
										disabled={isSaving}
									>
										Preview digest
									</Button>
									{scopeDirty && (
										<Button size="sm" onClick={handleSaveScope} loading={isSaving}>
											Save scope
										</Button>
									)}
								</div>
							</Panel>
						)}
					</SettingRow>
					<SettingRow
						className="p-4"
						active={webAnalyticsEnabled}
						icon={<ChartBarTrendUpIcon size={18} className="text-muted-foreground" />}
						label="Web analytics"
						description="Weekly overview of visitors, top pages and AI traffic. Only sent once the browser SDK is reporting visits."
						control={
							<>
								<Button
									variant="outline"
									size="sm"
									onClick={handlePreviewWebAnalytics}
									loading={isPreviewingWebAnalytics}
									disabled={isSaving}
								>
									Preview
								</Button>
								<Switch
									checked={webAnalyticsEnabled}
									onCheckedChange={handleWebAnalyticsToggle}
									disabled={isSaving || !email}
								/>
							</>
						}
					/>
				</div>
			</SettingsSection>
		</SettingsSections>
	)
}
