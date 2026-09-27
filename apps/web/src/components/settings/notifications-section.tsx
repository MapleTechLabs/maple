import { useMemo, useState } from "react"
import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { UpsertDigestSubscriptionRequest } from "@maple/domain/http"
import { useUser } from "@clerk/clerk-react"
import { formatWarehouseDateTime } from "@maple/query-engine"

import { Button } from "@maple/ui/components/ui/button"
import { Label } from "@maple/ui/components/ui/label"
import { Switch } from "@maple/ui/components/ui/switch"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { ChartBarTrendUpIcon, EnvelopeIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { snapRangeForCache } from "@/lib/time-utils"

/** Two arrays are the same scope regardless of the order they were picked in. */
const sameScope = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index])

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
	const [isSaving, setIsSaving] = useState(false)
	const [isPreviewing, setIsPreviewing] = useState(false)
	const [isPreviewingWebAnalytics, setIsPreviewingWebAnalytics] = useState(false)

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

	async function save(next: {
		enabled: boolean
		environments: string[]
		namespaces: string[]
		webAnalyticsEnabled?: boolean
	}): Promise<boolean> {
		if (!email) return false
		setIsSaving(true)
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
		setIsSaving(false)
		if (Exit.isSuccess(result)) {
			// Drop the local edits; the refreshed subscription now carries them.
			setEnabledEdit(null)
			setWebAnalyticsEdit(null)
			setScopeEdit(null)
			refreshSubscription()
		}
		return Exit.isSuccess(result)
	}

	async function handleToggle(checked: boolean) {
		setEnabledEdit(checked)
		const ok = await save({ enabled: checked, environments, namespaces })
		if (ok) {
			toastManager.add({
				title: checked ? "Weekly digest enabled" : "Weekly digest disabled",
				type: "success",
			})
		} else {
			toastManager.add({ title: "Failed to update notification preferences", type: "error" })
			setEnabledEdit(!checked)
		}
	}

	async function handleWebAnalyticsToggle(checked: boolean) {
		setWebAnalyticsEdit(checked)
		// `enabled` rides along: the upsert treats a missing value as "on".
		const ok = await save({ enabled, environments, namespaces, webAnalyticsEnabled: checked })
		if (ok) {
			toastManager.add({
				title: checked ? "Web analytics email enabled" : "Web analytics email disabled",
				type: "success",
			})
		} else {
			toastManager.add({ title: "Failed to update notification preferences", type: "error" })
			setWebAnalyticsEdit(!checked)
		}
	}

	async function handleSaveScope() {
		const ok = await save({ enabled, environments, namespaces })
		if (ok) {
			toastManager.add({ title: "Digest scope updated", type: "success" })
		} else {
			toastManager.add({ title: "Failed to update digest scope", type: "error" })
		}
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

	async function handlePreview() {
		setIsPreviewing(true)
		const result = await previewMutation({})
		if (Exit.isSuccess(result)) openPreview(result.value.html)
		else toastManager.add({ title: "Failed to generate digest preview", type: "error" })
		setIsPreviewing(false)
	}

	async function handlePreviewWebAnalytics() {
		setIsPreviewingWebAnalytics(true)
		const result = await previewWebAnalyticsMutation({})
		if (Exit.isSuccess(result)) openPreview(result.value.html)
		else toastManager.add({ title: "Failed to generate web analytics preview", type: "error" })
		setIsPreviewingWebAnalytics(false)
	}

	if (!settled || !user) {
		return (
			<div className="max-w-xl">
				<Skeleton className="h-16 w-full rounded-lg" />
			</div>
		)
	}

	return (
		<div className="max-w-xl space-y-1">
			<div
				className={cn(
					"flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors",
					enabled ? "border-primary/20 bg-primary/[0.02]" : "border-border",
				)}
			>
				<div className="flex items-center gap-3">
					<div className="text-muted-foreground">
						<EnvelopeIcon size={18} />
					</div>
					<div>
						<p className="text-sm font-medium">Email</p>
						<p className="text-muted-foreground text-xs">Weekly digest via email</p>
					</div>
				</div>
				<Switch checked={enabled} onCheckedChange={handleToggle} disabled={isSaving || !email} />
			</div>
			{enabled && (
				<div className="space-y-4 rounded-lg border border-border p-4">
					<div className="space-y-1.5">
						<Label htmlFor="digest-namespaces">Namespaces</Label>
						<MultiSelectCombobox
							id="digest-namespaces"
							emptyMessage="No namespaces detected."
							options={namespaceOptions}
							value={namespaces}
							onChange={setNamespaces}
							placeholder={namespaces.length === 0 ? "All namespaces" : "Add namespace..."}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="digest-environments">Environments</Label>
						<MultiSelectCombobox
							id="digest-environments"
							emptyMessage="No environments detected."
							options={environmentOptions}
							value={environments}
							onChange={setEnvironments}
							placeholder={
								environments.length === 0 ? "All environments" : "Add environment..."
							}
						/>
						<p className="text-muted-foreground text-xs">
							Leave both empty to receive a digest covering the whole organization.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handlePreview}
							disabled={isPreviewing || isSaving}
						>
							{isPreviewing ? "Generating..." : "Preview Digest"}
						</Button>
						{scopeDirty && (
							<Button size="sm" onClick={handleSaveScope} disabled={isSaving}>
								{isSaving ? "Saving..." : "Save scope"}
							</Button>
						)}
					</div>
				</div>
			)}
			<div
				className={cn(
					"!mt-3 flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors",
					webAnalyticsEnabled ? "border-primary/20 bg-primary/[0.02]" : "border-border",
				)}
			>
				<div className="flex items-center gap-3">
					<div className="text-muted-foreground">
						<ChartBarTrendUpIcon size={18} />
					</div>
					<div>
						<p className="text-sm font-medium">Web analytics</p>
						<p className="text-muted-foreground text-xs">
							Weekly overview of visitors, top pages and AI traffic. Only sent once the browser
							SDK is reporting visits.
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						onClick={handlePreviewWebAnalytics}
						disabled={isPreviewingWebAnalytics || isSaving}
					>
						{isPreviewingWebAnalytics ? "Generating..." : "Preview"}
					</Button>
					<Switch
						checked={webAnalyticsEnabled}
						onCheckedChange={handleWebAnalyticsToggle}
						disabled={isSaving || !email}
					/>
				</div>
			</div>
		</div>
	)
}
