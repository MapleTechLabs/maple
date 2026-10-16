import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { IngestKeyAttributeMode, IngestKeySignal } from "@maple/domain/http"
import type { V2CustomIngestKey, V2CustomIngestKeyWithSecret } from "@maple/domain/http/v2"
import { useState } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Input } from "@maple/ui/components/ui/input"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { ArrowPathIcon, KeyIcon, PencilIcon, PlusIcon, TrashIcon, XmarkIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { useAsyncAction, useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { SettingsSection } from "./settings-section"

const SIGNALS: ReadonlyArray<{ value: IngestKeySignal; label: string; hint: string }> = [
	{ value: "traces", label: "Traces", hint: "/v1/traces" },
	{ value: "logs", label: "Logs", hint: "/v1/logs" },
	{ value: "metrics", label: "Metrics", hint: "/v1/metrics" },
	{ value: "sessions", label: "Sessions", hint: "Replays and session events" },
	{ value: "events", label: "Events", hint: "Product events, incl. browser track()" },
]

const MODE_LABELS = {
	set: "Always set",
	default: "If missing",
} satisfies Record<IngestKeyAttributeMode, string>

const EXPIRY_LABELS = {
	keep: "Keep current",
	never: "Never",
	"30": "In 30 days",
	"90": "In 90 days",
	"365": "In 1 year",
} as const
type ExpiryChoice = keyof typeof EXPIRY_LABELS
const toExpiryChoice = (value: string | null): ExpiryChoice =>
	value === "keep" || value === "30" || value === "90" || value === "365" ? value : "never"

const toMode = (value: string | null): IngestKeyAttributeMode => (value === "default" ? "default" : "set")

interface AttributeDraft {
	readonly rowId: string
	readonly key: string
	readonly value: string
	readonly mode: IngestKeyAttributeMode
}

const newAttributeDraft = (key = "", mode: IngestKeyAttributeMode = "set"): AttributeDraft => ({
	rowId: crypto.randomUUID(),
	key,
	value: "",
	mode,
})

const signalsSummary = (signals: V2CustomIngestKey["allowed_signals"]) =>
	signals === null
		? "All signals"
		: SIGNALS.filter((signal) => signals.includes(signal.value))
				.map((signal) => signal.label)
				.join(", ")

const isExpired = (key: V2CustomIngestKey, now: number) =>
	key.expires_at !== null && new Date(key.expires_at).getTime() <= now

export function CustomIngestKeysSection() {
	const listResult = useAtomValue(customIngestKeysListAtom)
	const refreshKeys = useAtomRefresh(customIngestKeysListAtom)

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "createCustom"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "updateCustom"), {
		mode: "promiseExit",
	})
	const rollMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "rollCustom"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "deleteCustom"), {
		mode: "promiseExit",
	})

	const [dialogOpen, setDialogOpen] = useState(false)
	const [editing, setEditing] = useState<V2CustomIngestKey | null>(null)
	const [formName, setFormName] = useState("")
	const [formDescription, setFormDescription] = useState("")
	const [formSignals, setFormSignals] = useState<ReadonlyArray<IngestKeySignal>>(
		SIGNALS.map((s) => s.value),
	)
	const [formRateLimit, setFormRateLimit] = useState("")
	const [formAttributes, setFormAttributes] = useState<ReadonlyArray<AttributeDraft>>([])
	const [formExpiry, setFormExpiry] = useState<ExpiryChoice>("never")

	const [revealed, setRevealed] = useState<{ secret: V2CustomIngestKeyWithSecret; rolled: boolean } | null>(
		null,
	)
	const [rollConfirm, setRollConfirm] = useState<V2CustomIngestKey | null>(null)
	const [deleteConfirm, setDeleteConfirm] = useState<V2CustomIngestKey | null>(null)

	const keys = Result.builder(listResult)
		.onSuccess((response) => [...response.data])
		.orElse((): ReadonlyArray<V2CustomIngestKey> => [])
	const now = Date.now()

	function openCreateDialog() {
		setEditing(null)
		setFormName("")
		setFormDescription("")
		setFormSignals(SIGNALS.map((s) => s.value))
		setFormRateLimit("")
		setFormAttributes([newAttributeDraft("service.name", "default")])
		setFormExpiry("never")
		setDialogOpen(true)
	}

	function openEditDialog(key: V2CustomIngestKey) {
		setEditing(key)
		setFormName(key.name)
		setFormDescription(key.description ?? "")
		setFormSignals(key.allowed_signals ?? SIGNALS.map((s) => s.value))
		setFormRateLimit(key.rate_limit_rps === null ? "" : String(key.rate_limit_rps))
		setFormAttributes(
			key.resource_attributes.map((attribute) => ({ rowId: crypto.randomUUID(), ...attribute })),
		)
		setFormExpiry("keep")
		setDialogOpen(true)
	}

	const rateLimitText = formRateLimit.trim()
	const rateLimit = rateLimitText.length === 0 ? null : Number(rateLimitText)
	const rateLimitValid =
		rateLimit === null || (Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= 100_000)
	const attributes = formAttributes.filter((attribute) => attribute.key.trim().length > 0)
	const attributeKeys = attributes.map((attribute) => attribute.key.trim())
	const reservedAttribute = attributeKeys.find((key) => {
		const lower = key.toLowerCase()
		return lower === "org_id" || lower.startsWith("maple_")
	})
	const missingValue = attributes.find((attribute) => attribute.value.length === 0)
	const duplicateAttribute = attributeKeys.find((key, index) => attributeKeys.indexOf(key) !== index)
	const formValid =
		formName.trim().length > 0 &&
		formSignals.length > 0 &&
		rateLimitValid &&
		reservedAttribute === undefined &&
		duplicateAttribute === undefined &&
		missingValue === undefined

	const [handleSave, isSaving] = useAsyncAction(async () => {
		if (!formValid) return
		const allSignals = formSignals.length === SIGNALS.length
		const payload = {
			name: formName.trim(),
			description: formDescription.trim().length > 0 ? formDescription.trim() : null,
			allowed_signals: allSignals
				? null
				: SIGNALS.map((s) => s.value).filter((s) => formSignals.includes(s)),
			rate_limit_rps: rateLimit,
			resource_attributes: attributes.map(({ key, value, mode }) => ({ key: key.trim(), value, mode })),
		}
		// "keep" leaves the stored expiry untouched; it is only offered when editing.
		const expiresAt =
			formExpiry === "keep"
				? undefined
				: formExpiry === "never"
					? null
					: new Date(Date.now() + Number(formExpiry) * 86_400_000).toISOString()
		if (editing) {
			const update = expiresAt === undefined ? payload : { ...payload, expires_at: expiresAt }
			const ok = toastExit(await updateMutation({ params: { id: editing.id }, payload: update }), {
				success: "Ingest key updated. The gateway picks it up within a minute.",
				error: "Failed to update ingest key",
			})
			if (!ok) return
			setDialogOpen(false)
			refreshKeys()
			return
		}
		const result = await createMutation({ payload: { ...payload, expires_at: expiresAt ?? null } })
		if (!toastExit(result, { error: "Failed to create ingest key" })) return
		if (result._tag === "Success") setRevealed({ secret: result.value, rolled: false })
		setDialogOpen(false)
		refreshKeys()
	})

	const [handleRoll, isRolling] = useAsyncAction(async () => {
		if (!rollConfirm) return
		const result = await rollMutation({ params: { id: rollConfirm.id } })
		setRollConfirm(null)
		if (!toastExit(result, { error: "Failed to roll ingest key" })) return
		if (result._tag === "Success") setRevealed({ secret: result.value, rolled: true })
		refreshKeys()
	})

	async function handleDelete(key: V2CustomIngestKey) {
		const ok = toastExit(await deleteMutation({ params: { id: key.id } }), {
			success: "Ingest key deleted",
			error: "Failed to delete ingest key",
		})
		if (ok) refreshKeys()
		return ok
	}

	const toggle = useKeyedAsyncAction(async (_id: string, key: V2CustomIngestKey) => {
		const result = await updateMutation({ params: { id: key.id }, payload: { enabled: !key.enabled } })
		if (toastExit(result, { error: "Failed to update ingest key" })) refreshKeys()
	})

	const updateAttribute = (rowId: string, patch: Partial<Omit<AttributeDraft, "rowId">>) =>
		setFormAttributes((rows) => rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)))

	const keyCount = Result.isSuccess(listResult) ? keys.length : null

	return (
		<>
			<SettingsSection
				title={keyCount !== null && keyCount > 0 ? `Custom keys · ${keyCount}` : "Custom keys"}
				description="Named keys for a team, service or environment, each with its own allowed signals, rate limit and resource attributes. The default keys keep working."
				padded={false}
				actions={
					<Button size="sm" onClick={openCreateDialog}>
						<PlusIcon data-icon="inline-start" />
						Create key
					</Button>
				}
			>
				{Result.isInitial(listResult) ? (
					<SkeletonList
						rows={2}
						className="px-4"
						renderRow={() => (
							<div className="flex items-center gap-4 py-3">
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-40" />
									<Skeleton className="h-3.5 w-64" />
								</div>
								<Skeleton className="h-5 w-9 rounded-full" />
							</div>
						)}
					/>
				) : !Result.isSuccess(listResult) ? (
					<ErrorState
						error={listResult.cause}
						title="Couldn't load ingest keys"
						onRetry={() => refreshKeys()}
						className="border-0"
					/>
				) : keys.length === 0 ? (
					<Empty className="py-10">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<KeyIcon size={16} />
							</EmptyMedia>
							<EmptyTitle>No custom keys yet</EmptyTitle>
							<EmptyDescription>
								Give a team or environment its own key to cap its request rate, stamp a{" "}
								<InlineCode variant="plain">service.name</InlineCode> on everything it sends,
								or revoke it without touching anyone else.
							</EmptyDescription>
						</EmptyHeader>
						<Button size="sm" onClick={openCreateDialog}>
							<PlusIcon data-icon="inline-start" />
							Create key
						</Button>
					</Empty>
				) : (
					<div>
						{keys.map((key) => {
							const expired = isExpired(key, now)
							return (
								<div
									key={key.id}
									className={cn(
										"group hover:bg-muted/20 flex items-center gap-3 border-t px-4 py-2.5 transition-colors first:border-t-0",
										(!key.enabled || expired) && "opacity-55",
									)}
								>
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<div className="flex min-w-0 items-center gap-2">
											<TruncatedText className="text-sm font-medium">
												{key.name}
											</TruncatedText>
											<InlineCode
												variant="plain"
												className="text-2xs shrink-0 tracking-tight"
											>
												{key.key_prefix}…
											</InlineCode>
											{expired && (
												<Badge variant="outline" size="sm">
													Expired
												</Badge>
											)}
										</div>
										<div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
											<span>{signalsSummary(key.allowed_signals)}</span>
											<span className="font-mono">
												{key.rate_limit_rps === null
													? "No rate limit"
													: `${key.rate_limit_rps} req/s`}
											</span>
											{key.resource_attributes.length > 0 && (
												<span className="flex min-w-0 flex-wrap items-center gap-1">
													{key.resource_attributes.map((attribute) => (
														<InlineCode
															key={attribute.key}
															variant="plain"
															className="text-2xs break-all"
														>
															{attribute.key}={attribute.value}
														</InlineCode>
													))}
												</span>
											)}
											{key.expires_at !== null && !expired && (
												<span>Expires {formatRelativeTime(key.expires_at)}</span>
											)}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<IconButton
											className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
											onClick={() => openEditDialog(key)}
											label={`Edit ${key.name}`}
										>
											<PencilIcon />
										</IconButton>
										<Switch
											aria-label={`${key.enabled ? "Disable" : "Enable"} ${key.name}`}
											checked={key.enabled}
											onCheckedChange={() => void toggle.run(key.id, key)}
											disabled={toggle.isPending(key.id)}
										/>
										<RowActionsMenu label={`Actions for ${key.name}`}>
											<DropdownMenuItem onClick={() => setRollConfirm(key)}>
												<ArrowPathIcon />
												Roll secret
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setDeleteConfirm(key)}
											>
												<TrashIcon />
												Delete key
											</DropdownMenuItem>
										</RowActionsMenu>
									</div>
								</div>
							)
						})}
					</div>
				)}
			</SettingsSection>

			<FormDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editing ? "Edit ingest key" : "Create ingest key"}
				description={
					editing
						? "Changes reach the ingest gateway within a minute."
						: "The key is shown once after you create it."
				}
				onSubmit={() => void handleSave()}
				submitLabel={editing ? "Save changes" : "Create key"}
				pending={isSaving}
				submitDisabled={!formValid}
			>
				<Field>
					<FieldLabel htmlFor="ingest-key-name">Name</FieldLabel>
					<Input
						id="ingest-key-name"
						placeholder="e.g. Checkout staging"
						value={formName}
						maxLength={100}
						onChange={(e) => setFormName(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="ingest-key-description">Description</FieldLabel>
					<Input
						id="ingest-key-description"
						placeholder="Optional"
						maxLength={500}
						value={formDescription}
						onChange={(e) => setFormDescription(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel>Allowed signals</FieldLabel>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{SIGNALS.map((signal) => (
							<label
								key={signal.value}
								className="flex cursor-pointer items-start gap-2 text-sm"
							>
								<Checkbox
									className="mt-0.5"
									checked={formSignals.includes(signal.value)}
									onCheckedChange={(checked) =>
										setFormSignals((current) =>
											checked
												? [...current, signal.value]
												: current.filter((value) => value !== signal.value),
										)
									}
								/>
								<span className="flex flex-col">
									{signal.label}
									<span className="text-muted-foreground text-xs">{signal.hint}</span>
								</span>
							</label>
						))}
					</div>
					{formSignals.length === 0 && (
						<FieldDescription>Allow at least one signal.</FieldDescription>
					)}
				</Field>
				<Field>
					<FieldLabel htmlFor="ingest-key-rate-limit">Rate limit (requests per second)</FieldLabel>
					<Input
						id="ingest-key-rate-limit"
						inputMode="numeric"
						placeholder="No limit"
						value={formRateLimit}
						onChange={(e) => setFormRateLimit(e.target.value)}
					/>
					<FieldDescription>
						{rateLimitValid
							? "Split across the ingest servers. Requests over the limit get a 429 with Retry-After."
							: "Enter a whole number between 1 and 100000, or leave it empty."}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel>Resource attributes</FieldLabel>
					<div className="space-y-2">
						{formAttributes.map((attribute) => (
							<div key={attribute.rowId} className="flex items-center gap-2">
								<Input
									aria-label="Attribute key"
									placeholder="service.name"
									className="min-w-0 flex-1 font-mono text-xs"
									value={attribute.key}
									onChange={(e) =>
										updateAttribute(attribute.rowId, { key: e.target.value })
									}
								/>
								<Input
									aria-label="Attribute value"
									placeholder="value"
									className="min-w-0 flex-1 font-mono text-xs"
									value={attribute.value}
									onChange={(e) =>
										updateAttribute(attribute.rowId, { value: e.target.value })
									}
								/>
								<Select
									items={MODE_LABELS}
									value={attribute.mode}
									onValueChange={(value: string | null) =>
										updateAttribute(attribute.rowId, { mode: toMode(value) })
									}
								>
									<SelectTrigger aria-label="When to write it" className="w-36 shrink-0">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="set">{MODE_LABELS.set}</SelectItem>
										<SelectItem value="default">{MODE_LABELS.default}</SelectItem>
									</SelectContent>
								</Select>
								<IconButton
									className="text-muted-foreground hover:text-foreground shrink-0"
									label="Remove attribute"
									onClick={() =>
										setFormAttributes((rows) =>
											rows.filter((row) => row.rowId !== attribute.rowId),
										)
									}
								>
									<XmarkIcon />
								</IconButton>
							</div>
						))}
						<Button
							variant="outline"
							size="sm"
							disabled={formAttributes.length >= 20}
							onClick={() => setFormAttributes((rows) => [...rows, newAttributeDraft()])}
						>
							<PlusIcon data-icon="inline-start" />
							Add attribute
						</Button>
					</div>
					<FieldDescription>
						{reservedAttribute !== undefined
							? `"${reservedAttribute}" is reserved by Maple.`
							: duplicateAttribute !== undefined
								? `"${duplicateAttribute}" is listed twice.`
								: missingValue !== undefined
									? `Give "${missingValue.key.trim()}" a value, or remove it.`
									: "Written on every resource the key sends over OTLP. Rows with an empty key are ignored."}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel>Expires</FieldLabel>
					<Select
						items={EXPIRY_LABELS}
						value={formExpiry}
						onValueChange={(value: string | null) => setFormExpiry(toExpiryChoice(value))}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(EXPIRY_LABELS)
								.filter(([value]) => editing !== null || value !== "keep")
								.map(([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
					{editing !== null && editing.expires_at !== null && formExpiry === "keep" && (
						<FieldDescription>
							{isExpired(editing, now) ? "Expired" : "Expires"}{" "}
							{formatRelativeTime(editing.expires_at)}.
						</FieldDescription>
					)}
				</Field>
			</FormDialog>

			<Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{revealed?.rolled ? "Secret rolled" : "Ingest key created"}</DialogTitle>
						<DialogDescription>
							Copy the key now. You won't be able to see it again.
							{revealed?.rolled && " The previous secret stops working within a minute."}
						</DialogDescription>
					</DialogHeader>
					{revealed && (
						<DialogPanel className="space-y-3">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="text-foreground text-sm font-medium">
									{revealed.secret.name}
								</span>
								<Eyebrow variant="mono" className="text-muted-foreground">
									{signalsSummary(revealed.secret.allowed_signals)}
								</Eyebrow>
							</div>
							<CopyableField value={revealed.secret.secret} copyLabel="Ingest key" masked />
							<p className="text-muted-foreground text-xs">
								Send it as{" "}
								<InlineCode variant="plain">Authorization: Bearer &lt;key&gt;</InlineCode> to
								the same OTLP endpoint as the default keys.
							</p>
						</DialogPanel>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setRevealed(null)}>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={rollConfirm !== null}
				onOpenChange={(open) => !open && setRollConfirm(null)}
				title="Roll this key's secret?"
				description={
					<>
						<span className="text-foreground font-medium">{rollConfirm?.name}</span> gets a new
						secret and keeps its settings. Senders using the old secret are rejected within a
						minute.
					</>
				}
				confirmLabel="Roll secret"
				onConfirm={() => void handleRoll()}
				pending={isRolling}
			/>

			<ConfirmDialog
				open={deleteConfirm !== null}
				onOpenChange={(open) => !open && setDeleteConfirm(null)}
				title="Delete ingest key?"
				description={
					<>
						Senders using{" "}
						<span className="text-foreground font-medium">{deleteConfirm?.name}</span> are
						rejected within a minute. This cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={() => (deleteConfirm ? handleDelete(deleteConfirm) : undefined)}
			/>
		</>
	)
}
