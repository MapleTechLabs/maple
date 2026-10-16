import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import type { IngestKeyAttributeMode, IngestKeySignal } from "@maple/domain/http"
import type { V2CustomIngestKey } from "@maple/domain/http/v2"
import type * as React from "react"
import { useState } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Input } from "@maple/ui/components/ui/input"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { PlusIcon, XmarkIcon } from "@/components/icons"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { MODE_LABELS, type RevealedSecret, SIGNALS } from "./shared"

const MAX_ATTRIBUTES = 20

// An array, not an object: numeric-looking object keys would sort ahead of "never".
const EXPIRY_CHOICES = [
	{ value: "keep", label: "Keep current" },
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
] as const
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"]
const isExpiryChoice = (value: string): value is ExpiryChoice =>
	EXPIRY_CHOICES.some((choice) => choice.value === value)

// What the attribute preview shows a typical sender sending.
const SAMPLE_RESOURCE = new Map([
	["service.name", "checkout-api"],
	["deployment.environment", "production"],
])

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

/** One form section: heading and the why on the left, the fields on the right. */
function FormSection({
	title,
	description,
	children,
}: {
	title: string
	description: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<section className="grid gap-4 border-t py-6 @4xl:grid-cols-[13rem_1fr] @4xl:gap-10">
			<div className="space-y-1.5">
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
			</div>
			<div className="bg-card flex min-w-0 flex-col gap-4 rounded-lg border p-4">{children}</div>
		</section>
	)
}

function AttributePreview({ attributes }: { attributes: ReadonlyArray<AttributeDraft> }) {
	const rows = attributes.filter((attribute) => attribute.key.trim() !== "" && attribute.value !== "")
	if (rows.length === 0) return null
	return (
		<div className="bg-background -mx-4 -mb-4 space-y-2 rounded-b-lg border-t px-4 py-3">
			<p className="text-muted-foreground font-mono text-2xs">
				Preview: a sender sends{" "}
				{[...SAMPLE_RESOURCE].map(([key, value]) => `${key}=${value}`).join(", ")}
			</p>
			{rows.map((attribute) => {
				const key = attribute.key.trim()
				const sent = SAMPLE_RESOURCE.get(key)
				const outcome =
					sent === undefined
						? { value: attribute.value, note: "added", tone: "text-primary" }
						: attribute.mode === "set"
							? {
									value: `${sent} → ${attribute.value}`,
									note: "overwritten",
									tone: "text-primary",
								}
							: { value: sent, note: "kept, sender set it", tone: "text-muted-foreground" }
				return (
					<div key={attribute.rowId} className="flex gap-3 font-mono text-xs">
						<span className="text-muted-foreground w-48 shrink-0 truncate">{key}</span>
						<span className="min-w-0 flex-1 truncate">{outcome.value}</span>
						<span className={cn("shrink-0", outcome.tone)}>{outcome.note}</span>
					</div>
				)
			})}
		</div>
	)
}

/** Full-page form to create a key, or to configure `existing`. */
export function IngestKeyForm({
	existing,
	onCreated,
	onSaved,
	onCancel,
}: {
	existing: V2CustomIngestKey | null
	onCreated: (key: V2CustomIngestKey, revealed: RevealedSecret) => void
	onSaved: (key: V2CustomIngestKey) => void
	onCancel: () => void
}) {
	const refreshKeys = useAtomRefresh(customIngestKeysListAtom)
	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "createCustom"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiV2AtomClient.mutation("ingestKeys", "updateCustom"), {
		mode: "promiseExit",
	})

	const [name, setName] = useState(existing?.name ?? "")
	const [description, setDescription] = useState(existing?.description ?? "")
	const [signals, setSignals] = useState<ReadonlyArray<IngestKeySignal>>(
		existing?.allowed_signals ?? SIGNALS.map((signal) => signal.value),
	)
	const [rateLimitText, setRateLimitText] = useState(
		existing?.rate_limit_rps === null || existing === null ? "" : String(existing.rate_limit_rps),
	)
	const [attributes, setAttributes] = useState<ReadonlyArray<AttributeDraft>>(
		existing === null
			? [newAttributeDraft("service.name", "default")]
			: existing.resource_attributes.map((attribute) => ({ rowId: crypto.randomUUID(), ...attribute })),
	)
	const [expiry, setExpiry] = useState<ExpiryChoice>(
		existing !== null && existing.expires_at !== null ? "keep" : "never",
	)

	const trimmedRate = rateLimitText.trim()
	const rateLimit = trimmedRate.length === 0 ? null : Number(trimmedRate)
	const rateLimitValid =
		rateLimit === null || (Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= 100_000)
	const filled = attributes.filter((attribute) => attribute.key.trim().length > 0)
	const attributeKeys = filled.map((attribute) => attribute.key.trim())
	const reservedAttribute = attributeKeys.find((key) => {
		const lower = key.toLowerCase()
		return lower === "org_id" || lower.startsWith("maple_")
	})
	const missingValue = filled.find((attribute) => attribute.value.length === 0)
	const duplicateAttribute = attributeKeys.find((key, index) => attributeKeys.indexOf(key) !== index)
	const attributeProblem =
		reservedAttribute !== undefined
			? `"${reservedAttribute}" is reserved by Maple.`
			: duplicateAttribute !== undefined
				? `"${duplicateAttribute}" is listed twice.`
				: missingValue !== undefined
					? `Give "${missingValue.key.trim()}" a value, or remove it.`
					: null
	const formValid =
		name.trim().length > 0 && signals.length > 0 && rateLimitValid && attributeProblem === null

	const updateAttribute = (rowId: string, patch: Partial<Omit<AttributeDraft, "rowId">>) =>
		setAttributes((rows) => rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)))

	const [handleSubmit, saving] = useAsyncAction(async () => {
		if (!formValid) return
		const payload = {
			name: name.trim(),
			description: description.trim().length > 0 ? description.trim() : null,
			allowed_signals:
				signals.length === SIGNALS.length
					? null
					: SIGNALS.map((signal) => signal.value).filter((signal) => signals.includes(signal)),
			rate_limit_rps: rateLimit,
			resource_attributes: filled.map(({ key, value, mode }) => ({ key: key.trim(), value, mode })),
		}
		// "keep" leaves the stored expiry untouched; it is only offered when configuring.
		const expiresAt =
			expiry === "keep"
				? undefined
				: expiry === "never"
					? null
					: new Date(Date.now() + Number(expiry) * 86_400_000).toISOString()

		if (existing !== null) {
			const result = await updateMutation({
				params: { id: existing.id },
				payload: expiresAt === undefined ? payload : { ...payload, expires_at: expiresAt },
			})
			if (
				!toastExit(result, {
					success: "Ingest key saved. The gateway picks it up within a minute.",
					error: "Failed to save ingest key",
				})
			)
				return
			refreshKeys()
			if (result._tag === "Success") onSaved(result.value)
			return
		}
		const result = await createMutation({ payload: { ...payload, expires_at: expiresAt ?? null } })
		if (!toastExit(result, { error: "Failed to create ingest key" })) return
		refreshKeys()
		if (result._tag === "Success") {
			const { secret, ...key } = result.value
			onCreated(key, { keyId: key.id, secret, rolled: false })
		}
	})

	const expiryChoices = EXPIRY_CHOICES.filter(
		(choice) => choice.value !== "keep" || (existing !== null && existing.expires_at !== null),
	)

	return (
		<form
			className="@container flex w-full max-w-4xl flex-col"
			onSubmit={(event) => {
				event.preventDefault()
				void handleSubmit()
			}}
		>
			<header className="space-y-1.5 pb-6">
				<h1 className="font-display text-2xl font-medium tracking-tight">
					{existing === null ? "New ingest key" : `Configure ${existing.name}`}
				</h1>
				<p className="text-muted-foreground text-sm">
					{existing === null
						? "A named key for one team, service or environment. The default keys keep working."
						: "Changes reach every ingest server within a minute."}
				</p>
			</header>

			<FormSection
				title="Basics"
				description="Name it after who sends with it, so the list and audit log read well."
			>
				<Field>
					<FieldLabel htmlFor="ingest-key-name">Name</FieldLabel>
					<Input
						id="ingest-key-name"
						placeholder="e.g. Checkout staging"
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="ingest-key-note">
						Note <span className="text-muted-foreground font-normal">(optional)</span>
					</FieldLabel>
					<Input
						id="ingest-key-note"
						placeholder="Where is this key deployed?"
						maxLength={500}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</Field>
			</FormSection>

			<FormSection
				title="Signals"
				description="What this key may send. Anything else is rejected with a 403."
			>
				<div className="grid gap-2 sm:grid-cols-2">
					{SIGNALS.map((signal) => {
						const checked = signals.includes(signal.value)
						return (
							<label
								key={signal.value}
								className={cn(
									"flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
									checked ? "border-primary/60 bg-primary/[0.06]" : "hover:bg-muted/30",
								)}
							>
								<Checkbox
									className="mt-0.5"
									checked={checked}
									onCheckedChange={(next) =>
										setSignals((current) =>
											next
												? [...current, signal.value]
												: current.filter((value) => value !== signal.value),
										)
									}
								/>
								<span className="flex flex-col gap-0.5">
									<span className={cn("text-sm", !checked && "text-muted-foreground")}>
										{signal.label}
									</span>
									<span className="text-muted-foreground font-mono text-2xs">
										{signal.hint}
									</span>
								</span>
							</label>
						)
					})}
				</div>
				{signals.length === 0 && <FieldDescription>Allow at least one signal.</FieldDescription>}
			</FormSection>

			<FormSection
				title="Limits"
				description="Cap a noisy sender before it eats your quota. Requests over the limit get a 429 and retry."
			>
				<Field>
					<FieldLabel htmlFor="ingest-key-rate-limit">Rate limit</FieldLabel>
					<div className="flex items-center gap-3">
						<InputGroup className="w-44">
							<InputGroupInput
								id="ingest-key-rate-limit"
								inputMode="numeric"
								placeholder="No limit"
								value={rateLimitText}
								onChange={(event) => setRateLimitText(event.target.value)}
								controlClassName="font-mono tabular-nums"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupText>req/s</InputGroupText>
							</InputGroupAddon>
						</InputGroup>
						<span className="text-muted-foreground text-xs">Leave empty for no limit</span>
					</div>
					<FieldDescription>
						{rateLimitValid
							? "Split across the ingest servers, so short bursts can run a little over."
							: "Enter a whole number between 1 and 100000, or leave it empty."}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel>Expires</FieldLabel>
					<ToggleGroup
						variant="outline"
						size="sm"
						aria-label="Expires"
						value={[expiry]}
						onValueChange={(values) => {
							const next = values.find((value) => value !== expiry)
							if (next !== undefined && isExpiryChoice(next)) setExpiry(next)
						}}
					>
						{expiryChoices.map((choice) => (
							<ToggleGroupItem key={choice.value} value={choice.value}>
								{choice.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{existing !== null && existing.expires_at !== null && expiry === "keep" && (
						<FieldDescription>
							{existing.status === "expired" ? "Expired" : "Expires"}{" "}
							{formatRelativeTime(existing.expires_at)}.
						</FieldDescription>
					)}
				</Field>
			</FormSection>

			<FormSection
				title="Resource attributes"
				description="Stamp attributes on everything sent with this key. Useful when you can't change the sender's config."
			>
				<div className="space-y-2">
					{attributes.length > 0 && (
						<div className="text-muted-foreground hidden gap-2 text-2xs sm:flex">
							<span className="min-w-0 flex-1">Attribute</span>
							<span className="min-w-0 flex-1">Value</span>
							<span className="w-44 shrink-0">When</span>
							<span className="w-8 shrink-0" />
						</div>
					)}
					{attributes.map((attribute) => (
						<div
							key={attribute.rowId}
							className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
						>
							<Input
								aria-label="Attribute key"
								placeholder="service.name"
								className="w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1"
								value={attribute.key}
								onChange={(event) =>
									updateAttribute(attribute.rowId, { key: event.target.value })
								}
							/>
							<Input
								aria-label="Attribute value"
								placeholder="value"
								className="w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1"
								value={attribute.value}
								onChange={(event) =>
									updateAttribute(attribute.rowId, { value: event.target.value })
								}
							/>
							<ToggleGroup
								variant="outline"
								size="sm"
								aria-label={`When to write ${attribute.key || "this attribute"}`}
								className="w-44 shrink-0"
								value={[attribute.mode]}
								onValueChange={(values) => {
									const next = values.find((value) => value !== attribute.mode)
									if (next === "set" || next === "default")
										updateAttribute(attribute.rowId, { mode: next })
								}}
							>
								<ToggleGroupItem value="set" className="flex-1">
									{MODE_LABELS.set}
								</ToggleGroupItem>
								<ToggleGroupItem value="default" className="flex-1">
									{MODE_LABELS.default}
								</ToggleGroupItem>
							</ToggleGroup>
							<IconButton
								className="text-muted-foreground hover:text-foreground shrink-0"
								label="Remove attribute"
								onClick={() =>
									setAttributes((rows) =>
										rows.filter((row) => row.rowId !== attribute.rowId),
									)
								}
							>
								<XmarkIcon />
							</IconButton>
						</div>
					))}
					<div className="flex items-center gap-3">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-primary -ml-2"
							disabled={attributes.length >= MAX_ATTRIBUTES}
							onClick={() => setAttributes((rows) => [...rows, newAttributeDraft()])}
						>
							<PlusIcon data-icon="inline-start" />
							Add attribute
						</Button>
						{attributeProblem !== null && (
							<span className="text-destructive text-xs" role="alert">
								{attributeProblem}
							</span>
						)}
					</div>
				</div>
				<AttributePreview attributes={attributes} />
			</FormSection>

			<footer className="flex flex-wrap items-center gap-3 border-t py-5">
				<span className="text-muted-foreground grow text-xs">
					{existing === null
						? "The secret is shown once, on the next screen."
						: "Rolling the secret is on the key page."}
				</span>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!formValid} loading={saving}>
					{existing === null ? "Create key" : "Save changes"}
				</Button>
			</footer>
		</form>
	)
}
