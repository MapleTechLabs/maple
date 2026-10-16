import { useState } from "react"
import { OPENROUTER_BYOK_ADDON_ID } from "@maple/domain/billing"
import { OpenRouterKeyUpdateRequest } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { Panel } from "@maple/ui/components/ui/panel"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toastManager } from "@maple/ui/components/ui/toast"
import { ErrorState } from "@/components/common/error-state"
import { SectionHeading } from "@/components/common/section-heading"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { buildCheckoutSuccessUrl } from "@/lib/billing/checkout-return"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { showErrorToast, toastExit } from "@/lib/error-toast"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

const KEY_REACTIVITY_KEYS = ["openRouterKey"]

const ADD_ON_PRICE = "$15/month"

/**
 * The org's own OpenRouter key. Without the add-on it is the upsell; with it, the key form.
 * Admin-only: the nav hides the tab from everyone else, and the API refuses their writes.
 */
export function AiProviderSection() {
	const keyQueryAtom = retainedInternalQuery("openRouterKey", "get", {
		reactivityKeys: KEY_REACTIVITY_KEYS,
	})
	const keyResult = useAtomValue(keyQueryAtom)
	const refreshKey = useAtomRefresh(keyQueryAtom)

	const setMutation = useAtomSet(MapleInternalAtomClient.mutation("openRouterKey", "set"), {
		mode: "promiseExit",
	})
	const removeMutation = useAtomSet(MapleInternalAtomClient.mutation("openRouterKey", "remove"), {
		mode: "promiseExit",
	})
	const { attach } = useBillingActions()

	const [draft, setDraft] = useState("")
	const [confirmRemove, setConfirmRemove] = useState(false)
	const [confirmAddOn, setConfirmAddOn] = useState(false)

	const [saveKey, isSaving] = useAsyncAction(async (apiKey: string) => {
		const exit = await setMutation({
			payload: new OpenRouterKeyUpdateRequest({ apiKey }),
			reactivityKeys: KEY_REACTIVITY_KEYS,
		})
		if (toastExit(exit, { success: "OpenRouter key saved", error: "Failed to save the key" })) {
			setDraft("")
		}
	})

	const [removeKey, isRemoving] = useAsyncAction(async () => {
		const exit = await removeMutation({ reactivityKeys: KEY_REACTIVITY_KEYS })
		return toastExit(exit, { success: "OpenRouter key removed", error: "Failed to remove the key" })
	})

	const [addOn, isAttaching] = useAsyncAction(() =>
		attach({
			planId: OPENROUTER_BYOK_ADDON_ID,
			successUrl: buildCheckoutSuccessUrl(window.location.href),
		}).then(
			(result) => {
				if (result.paymentUrl) {
					window.location.href = result.paymentUrl
					return
				}
				toastManager.add({ title: "Add-on added", type: "success" })
				refreshKey()
			},
			(error: unknown) => showErrorToast(error, { title: "Failed to add the add-on" }),
		),
	)

	const busy = isSaving || isRemoving

	return (
		<Panel padded className="gap-6">
			{Result.builder(keyResult)
				.onInitial(() => <Skeleton className="h-32 w-full" />)
				.onError((error) => (
					<ErrorState
						error={error}
						title="Failed to load the AI provider settings"
						variant="row"
						onRetry={() => refreshKey()}
					/>
				))
				.onSuccess((current) => (
					<>
						<div className="space-y-1">
							<SectionHeading
								as="h3"
								title="Bring your own OpenRouter key"
								badge={
									current.entitled && current.configured ? (
										<Badge variant="ok">In use</Badge>
									) : null
								}
								className="items-center gap-2"
							/>
							<p className="text-sm text-muted-foreground">
								Run Maple's AI on your own OpenRouter account: chat, incident investigations
								and pull request reviews. OpenRouter bills you for the tokens, and Maple stops
								charging for AI usage. Models stay the same.
							</p>
						</div>

						{current.configured ? (
							<SettingRow
								label="Current key"
								description={
									!current.entitled
										? "Not in use: the add-on has lapsed, so Maple's own key runs your AI."
										: current.updatedAt === null
											? undefined
											: `Saved ${new Date(current.updatedAt).toLocaleString()}`
								}
								control={
									<div className="flex items-center gap-3">
										<code className="font-mono text-sm">sk-or-...{current.keyHint}</code>
										<Button
											variant="outline"
											disabled={busy}
											onClick={() => setConfirmRemove(true)}
										>
											Remove
										</Button>
									</div>
								}
							/>
						) : null}

						{current.entitled ? (
							<form
								className="flex flex-col gap-3 sm:flex-row sm:items-end"
								onSubmit={(event) => {
									event.preventDefault()
									const apiKey = draft.trim()
									if (apiKey !== "") saveKey(apiKey)
								}}
							>
								<Field className="flex-1">
									<FieldLabel htmlFor="openrouter-api-key">
										{current.configured ? "Replace key" : "OpenRouter API key"}
									</FieldLabel>
									<Input
										id="openrouter-api-key"
										type="password"
										autoComplete="off"
										placeholder="sk-or-v1-..."
										value={draft}
										disabled={busy}
										onChange={(event) => setDraft(event.target.value)}
									/>
									<FieldDescription>
										Create one at openrouter.ai/settings/keys. Maple checks it with
										OpenRouter, then stores it encrypted.
									</FieldDescription>
								</Field>
								<Button type="submit" disabled={busy || draft.trim() === ""}>
									{isSaving ? "Checking..." : "Save key"}
								</Button>
							</form>
						) : (
							<SettingRow
								label={`Add-on, ${ADD_ON_PRICE}`}
								description="Billed with your plan. Cancel any time from billing, and Maple's own key takes over again."
								control={
									<Button disabled={isAttaching} onClick={() => setConfirmAddOn(true)}>
										Add to plan
									</Button>
								}
							/>
						)}

						{/* With a card on file the attach charges at once and no checkout page follows. */}
						<ConfirmDialog
							open={confirmAddOn}
							onOpenChange={setConfirmAddOn}
							tone="default"
							title={`Add the OpenRouter add-on for ${ADD_ON_PRICE}?`}
							description="If your organization has a payment method on file, the add-on is attached right away and billed with your plan. Otherwise you continue to checkout."
							confirmLabel="Add to plan"
							pending={isAttaching}
							onConfirm={() => addOn()}
						/>

						<ConfirmDialog
							open={confirmRemove}
							onOpenChange={setConfirmRemove}
							title="Remove your OpenRouter key?"
							description="Maple's AI goes back to Maple's own key, and AI usage is billed on your plan again."
							confirmLabel="Remove key"
							pending={isRemoving}
							onConfirm={() => removeKey()}
						/>
					</>
				))
				.render()}
		</Panel>
	)
}
