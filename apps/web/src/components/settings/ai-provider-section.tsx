import { type ReactNode, useState } from "react"
import { OPENROUTER_BYOK_ADDON_ID } from "@maple/domain/billing"
import { type OpenRouterKeyDocument, OpenRouterKeyUpdateRequest } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toastManager } from "@maple/ui/components/ui/toast"
import { cn } from "@maple/ui/lib/utils"
import { ErrorState } from "@/components/common/error-state"
import { SettingsSection } from "@/components/settings/settings-section"
import { useBillingActions } from "@/hooks/use-billing-actions"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { buildCheckoutSuccessUrl } from "@/lib/billing/checkout-return"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { showErrorToast, toastExit } from "@/lib/error-toast"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

const KEY_REACTIVITY_KEYS = ["openRouterKey"]

const ADD_ON_PRICE = "$15/month"

type Provider = "managed" | "openrouter"

/**
 * Which models run the org's AI: Maple managed, or the org's own OpenRouter key (an add-on).
 * Admin-only: the nav hides the tab from everyone else, and the API refuses their writes.
 */
export function ModelProviderSection() {
	const keyQueryAtom = retainedInternalQuery("openRouterKey", "get", {
		reactivityKeys: KEY_REACTIVITY_KEYS,
	})
	const keyResult = useAtomValue(keyQueryAtom)
	const refreshKey = useAtomRefresh(keyQueryAtom)

	return (
		<SettingsSection
			title="Model provider"
			description="Runs chat, investigations and pull request reviews. Models stay the same either way."
			framed={false}
		>
			{Result.builder(keyResult)
				.onInitial(() => <Skeleton className="h-28 w-full" />)
				.onError((error) => (
					<ErrorState
						error={error}
						title="Failed to load the model provider"
						variant="row"
						onRetry={() => refreshKey()}
					/>
				))
				.onSuccess((current) => <ProviderChoice current={current} onAddOnAttached={refreshKey} />)
				.render()}
		</SettingsSection>
	)
}

function ProviderChoice({
	current,
	onAddOnAttached,
}: {
	current: OpenRouterKeyDocument
	onAddOnAttached: () => void
}) {
	const removeMutation = useAtomSet(MapleInternalAtomClient.mutation("openRouterKey", "remove"), {
		mode: "promiseExit",
	})
	const inUse = current.entitled && current.configured
	// A pick only opens a card; the provider itself changes when a key is saved or removed.
	const [picked, setPicked] = useState<Provider | null>(null)
	const selected: Provider = picked ?? (inUse ? "openrouter" : "managed")
	const [confirmRemove, setConfirmRemove] = useState(false)

	const [removeKey, isRemoving] = useAsyncAction(async () => {
		const exit = await removeMutation({ reactivityKeys: KEY_REACTIVITY_KEYS })
		if (toastExit(exit, { success: "Switched to Maple managed", error: "Failed to remove the key" })) {
			setPicked(null)
		}
	})

	return (
		<>
			<RadioGroup
				value={selected}
				onValueChange={(value) => {
					if (value === "managed" && inUse) setConfirmRemove(true)
					else setPicked(value === "openrouter" ? "openrouter" : "managed")
				}}
				className="grid gap-3 sm:grid-cols-2"
			>
				<ProviderCard
					value="managed"
					selected={selected === "managed"}
					title="Maple managed"
					description="No setup. AI usage is billed on your plan."
				/>
				<ProviderCard
					value="openrouter"
					selected={selected === "openrouter"}
					title="Your OpenRouter key"
					badge={inUse ? <Badge variant="ok">In use</Badge> : null}
					description="OpenRouter bills the tokens. Maple stops charging for AI usage."
				>
					<OpenRouterKeyPanel
						current={current}
						busy={isRemoving}
						onRemove={() => setConfirmRemove(true)}
						onAddOnAttached={onAddOnAttached}
					/>
				</ProviderCard>
			</RadioGroup>

			<ConfirmDialog
				open={confirmRemove}
				onOpenChange={setConfirmRemove}
				title="Remove your OpenRouter key?"
				description="Maple managed models take over, and AI usage is billed on your plan again."
				confirmLabel="Remove key"
				pending={isRemoving}
				onConfirm={() => removeKey()}
			/>
		</>
	)
}

function ProviderCard({
	value,
	selected,
	title,
	badge,
	description,
	children,
}: {
	value: Provider
	selected: boolean
	title: string
	badge?: ReactNode
	description: string
	/** Shown only while this card is selected. */
	children?: ReactNode
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 rounded-md border bg-card p-4 transition-colors",
				selected && "border-primary/60 bg-primary/[0.05]",
			)}
		>
			<label className="flex cursor-pointer flex-col gap-2">
				<span className="flex items-center gap-2.5">
					<Radio value={value} />
					<span className="text-sm font-medium text-foreground">{title}</span>
					{badge}
				</span>
				<span className="pl-6.5 text-xs leading-relaxed text-muted-foreground">{description}</span>
			</label>
			{selected && children !== undefined ? <div className="pl-6.5">{children}</div> : null}
		</div>
	)
}

/** Inside the OpenRouter card: the add-on upsell, the saved key, or the key form. */
function OpenRouterKeyPanel({
	current,
	busy,
	onRemove,
	onAddOnAttached,
}: {
	current: OpenRouterKeyDocument
	busy: boolean
	onRemove: () => void
	onAddOnAttached: () => void
}) {
	const [replacing, setReplacing] = useState(false)

	if (!current.entitled)
		return <AddOnUpsell current={current} onAttached={onAddOnAttached} onRemove={onRemove} busy={busy} />

	if (current.configured && !replacing) {
		return (
			<div className="flex items-center justify-between gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-2.5">
				<code className="truncate font-mono text-sm">sk-or-...{current.keyHint}</code>
				<div className="flex shrink-0 items-center gap-1">
					<Button variant="outline" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
						Replace
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive-foreground"
						disabled={busy}
						onClick={onRemove}
					>
						Remove
					</Button>
				</div>
			</div>
		)
	}

	return (
		<OpenRouterKeyForm
			replacing={current.configured}
			onCancel={current.configured ? () => setReplacing(false) : undefined}
			onSaved={() => setReplacing(false)}
		/>
	)
}

function OpenRouterKeyForm({
	replacing,
	onCancel,
	onSaved,
}: {
	replacing: boolean
	onCancel?: () => void
	onSaved: () => void
}) {
	const setMutation = useAtomSet(MapleInternalAtomClient.mutation("openRouterKey", "set"), {
		mode: "promiseExit",
	})
	const [draft, setDraft] = useState("")

	const [saveKey, isSaving] = useAsyncAction(async (apiKey: string) => {
		const exit = await setMutation({
			payload: new OpenRouterKeyUpdateRequest({ apiKey }),
			reactivityKeys: KEY_REACTIVITY_KEYS,
		})
		if (toastExit(exit, { success: "OpenRouter key saved", error: "Failed to save the key" })) {
			setDraft("")
			onSaved()
		}
	})

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault()
				const apiKey = draft.trim()
				if (apiKey !== "") saveKey(apiKey)
			}}
		>
			<Field>
				<FieldLabel htmlFor="openrouter-api-key">
					{replacing ? "New OpenRouter API key" : "OpenRouter API key"}
				</FieldLabel>
				<Input
					id="openrouter-api-key"
					type="password"
					autoComplete="off"
					placeholder="sk-or-v1-..."
					value={draft}
					disabled={isSaving}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<FieldDescription>
					Create one at openrouter.ai/settings/keys. Maple checks it with OpenRouter, then stores it
					encrypted.
				</FieldDescription>
			</Field>
			<div className="flex items-center gap-1.5">
				<Button type="submit" size="sm" loading={isSaving} disabled={draft.trim() === ""}>
					{isSaving ? "Checking..." : "Save key"}
				</Button>
				{onCancel ? (
					<Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={onCancel}>
						Cancel
					</Button>
				) : null}
			</div>
		</form>
	)
}

function AddOnUpsell({
	current,
	onAttached,
	onRemove,
	busy,
}: {
	current: OpenRouterKeyDocument
	onAttached: () => void
	onRemove: () => void
	busy: boolean
}) {
	const [confirmAddOn, setConfirmAddOn] = useState(false)
	const { attach } = useBillingActions()

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
				onAttached()
			},
			(error: unknown) => showErrorToast(error, { title: "Failed to add the add-on" }),
		),
	)

	return (
		<div className="flex flex-col gap-3">
			{current.configured ? (
				<div className="flex items-center justify-between gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-2.5">
					<p className="text-xs leading-relaxed text-muted-foreground">
						Your saved key (sk-or-...{current.keyHint}) is not in use because the add-on has
						lapsed.
					</p>
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0 text-destructive-foreground"
						disabled={busy}
						onClick={onRemove}
					>
						Remove
					</Button>
				</div>
			) : null}
			<p className="text-xs leading-relaxed text-muted-foreground">
				Needs the OpenRouter add-on, {ADD_ON_PRICE}, billed with your plan. Cancel any time from
				billing.
			</p>
			<Button size="sm" className="w-fit" disabled={isAttaching} onClick={() => setConfirmAddOn(true)}>
				Add to plan
			</Button>
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
		</div>
	)
}
