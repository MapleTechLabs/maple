import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
} from "@maple/domain/http"
import type { V2AttributeMapping } from "@maple/domain/http/v2"
import { useState } from "react"

import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import {
	ArrowRightFromLineIcon,
	ArrowRightIcon,
	ArrowUpDownIcon,
	BracketsCurlyIcon,
	CopyIcon,
	CubeIcon,
	type IconComponent,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	ingestAttributeMappingsListAtom,
	recommendationIssuesListAtom,
} from "@/lib/services/atoms/ingestion-atoms"
import { AttributeKeyAutocomplete } from "./attribute-key-autocomplete"
import { DocsLink, EmptyActions } from "@/components/common/docs-link"
import { ErrorState } from "@/components/common/error-state"
import { useAsyncAction, useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"
import { SettingsSection } from "./settings-section"

const SOURCE_CONTEXT_LABELS: Record<IngestMappingSourceContext, string> = {
	span: "Span attribute",
	resource: "Resource attribute",
} satisfies Record<IngestMappingSourceContext, string>

const OPERATION_LABELS: Record<IngestMappingOperation, string> = {
	move: "Move",
	copy: "Copy",
} satisfies Record<IngestMappingOperation, string>

// Copy is additive (keeps the source) → info; Move removes the source key → warn caution.
const OPERATION_BADGE: Record<
	IngestMappingOperation,
	{ icon: IconComponent; variant: "info" | "warn"; tone: string }
> = {
	copy: { icon: CopyIcon, variant: "info", tone: TONE_TEXT.info },
	move: { icon: ArrowRightFromLineIcon, variant: "warn", tone: TONE_TEXT.warn },
} satisfies Record<IngestMappingOperation, { icon: IconComponent; variant: "info" | "warn"; tone: string }>

const SOURCE_CONTEXT_ICON: Record<IngestMappingSourceContext, IconComponent> = {
	span: BracketsCurlyIcon,
	resource: CubeIcon,
} satisfies Record<IngestMappingSourceContext, IconComponent>

const toSourceContext = (value: string | null): IngestMappingSourceContext =>
	value === "resource" ? "resource" : "span"
const toOperation = (value: string | null): IngestMappingOperation => (value === "move" ? "move" : "copy")

export function AttributeMappingsSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [deleteConfirm, setDeleteConfirm] = useState<V2AttributeMapping | null>(null)

	const [editing, setEditing] = useState<V2AttributeMapping | null>(null)
	const [formName, setFormName] = useState("")
	const [formSourceContext, setFormSourceContext] = useState<IngestMappingSourceContext>("span")
	const [formSourceKey, setFormSourceKey] = useState("")
	const [formTargetKey, setFormTargetKey] = useState("")
	const [formOperation, setFormOperation] = useState<IngestMappingOperation>("copy")

	const listResult = useAtomValue(ingestAttributeMappingsListAtom)
	const refreshMappings = useAtomRefresh(ingestAttributeMappingsListAtom)
	// Mappings reconcile the recommendation list server-side, so refresh both after a change.
	const refreshRecommendations = useAtomRefresh(recommendationIssuesListAtom)

	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiV2AtomClient.mutation("attributeMappings", "delete"), {
		mode: "promiseExit",
	})

	const mappings = Result.builder(listResult)
		.onSuccess((response) => [...response.data])
		.orElse(() => [] as V2AttributeMapping[])

	function openAddDialog() {
		setEditing(null)
		setFormName("")
		setFormSourceContext("span")
		setFormSourceKey("")
		setFormTargetKey("")
		setFormOperation("copy")
		setDialogOpen(true)
	}

	function openEditDialog(mapping: V2AttributeMapping) {
		setEditing(mapping)
		setFormName(mapping.name)
		setFormSourceContext(mapping.source_context)
		setFormSourceKey(mapping.source_key)
		setFormTargetKey(mapping.target_key)
		setFormOperation(mapping.operation)
		setDialogOpen(true)
	}

	const formValid =
		formName.trim().length > 0 && formSourceKey.trim().length > 0 && formTargetKey.trim().length > 0

	const [handleSave, isSaving] = useAsyncAction(async () => {
		if (!formValid) return
		const payload = {
			name: formName.trim(),
			source_context: formSourceContext,
			source_key: formSourceKey.trim(),
			target_key: formTargetKey.trim(),
			operation: formOperation,
		}
		const ok = editing
			? toastExit(await updateMutation({ params: { id: editing.id }, payload }), {
					success: "Attribute mapping updated",
					error: "Failed to update attribute mapping",
				})
			: toastExit(await createMutation({ payload }), {
					success: "Attribute mapping created",
					error: "Failed to create attribute mapping",
				})
		if (!ok) return
		setDialogOpen(false)
		refreshMappings()
		refreshRecommendations()
	})

	async function handleDelete(mappingId: IngestAttributeMappingId) {
		const result = await deleteMutation({ params: { id: mappingId } })
		const ok = toastExit(result, {
			success: "Attribute mapping deleted",
			error: "Failed to delete attribute mapping",
		})
		if (ok) {
			refreshMappings()
			refreshRecommendations()
		}
		return ok
	}

	const toggle = useKeyedAsyncAction(async (_id: IngestAttributeMappingId, mapping: V2AttributeMapping) => {
		const result = await updateMutation({
			params: { id: mapping.id },
			payload: { enabled: !mapping.enabled },
		})
		if (toastExit(result, { error: "Failed to update attribute mapping" })) refreshMappings()
	})

	const mappingCount = Result.isSuccess(listResult) ? mappings.length : null

	const PreviewOpIcon = OPERATION_BADGE[formOperation].icon
	const showPreview = formSourceKey.trim().length > 0 && formTargetKey.trim().length > 0

	return (
		<>
			<SettingsSection
				title={
					mappingCount !== null && mappingCount > 0
						? `Attribute mappings · ${mappingCount}`
						: "Attribute mappings"
				}
				description="Rename or promote span attribute keys at ingest. Applied only to spans received after a rule is saved."
				padded={false}
				actions={
					<Button size="sm" onClick={openAddDialog}>
						<PlusIcon data-icon="inline-start" />
						Add mapping
					</Button>
				}
			>
				<div>
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
							title="Couldn't load mappings"
							onRetry={() => refreshMappings()}
							className="border-0"
						/>
					) : mappings.length === 0 ? (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ArrowUpDownIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No attribute mappings yet</EmptyTitle>
								<EmptyDescription>
									Mappings rename span attribute keys that do not follow OpenTelemetry
									names, so dashboards and alerts find them. Rules apply to new spans only.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyActions>
								<Button size="sm" onClick={openAddDialog}>
									<PlusIcon data-icon="inline-start" />
									Add mapping
								</Button>
								<DocsLink page="otelConventions" />
							</EmptyActions>
						</Empty>
					) : (
						<div>
							{/* column header */}
							<div className="flex items-center gap-3 px-4 py-1.5">
								<Eyebrow variant="mono" className="w-44 shrink-0" as="div">
									Name
								</Eyebrow>
								<Eyebrow variant="mono" className="flex-1" as="div">
									Rule
								</Eyebrow>
								<Eyebrow variant="mono" className="hidden w-24 shrink-0 md:block" as="div">
									Operation
								</Eyebrow>
								<Eyebrow variant="mono" className="hidden w-20 shrink-0 md:block" as="div">
									Context
								</Eyebrow>
								<div className="w-28 shrink-0" />
							</div>

							{mappings.map((mapping) => {
								const operation = OPERATION_BADGE[mapping.operation]
								return (
									<div
										key={mapping.id}
										className={cn(
											"group hover:bg-muted/20 flex items-center gap-3 border-t px-4 py-2.5 transition-colors",
											!mapping.enabled && "opacity-55",
										)}
									>
										<TruncatedText className="w-44 shrink-0 text-sm">
											{mapping.name}
										</TruncatedText>

										<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
											<InlineCode variant="plain">{mapping.source_key}</InlineCode>
											<ArrowRightIcon
												size={12}
												className="text-muted-foreground shrink-0"
											/>
											<InlineCode variant="plain" className="text-foreground">
												{mapping.target_key}
											</InlineCode>
										</div>

										<Eyebrow
											variant="mono"
											className={cn("hidden w-24 shrink-0 md:block", operation.tone)}
										>
											{OPERATION_LABELS[mapping.operation]}
										</Eyebrow>

										<span className="text-muted-foreground hidden w-20 shrink-0 text-xs md:block">
											{mapping.source_context === "resource" ? "Resource" : "Spans"}
										</span>

										<div className="flex w-28 shrink-0 items-center justify-end gap-1.5">
											<div className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
												<IconButton
													className="text-muted-foreground hover:text-foreground"
													onClick={() => openEditDialog(mapping)}
													label="Edit mapping"
												>
													<PencilIcon size={14} />
												</IconButton>
												<IconButton
													className="text-muted-foreground hover:text-destructive"
													onClick={() => setDeleteConfirm(mapping)}
													label="Delete mapping"
												>
													<TrashIcon size={14} />
												</IconButton>
											</div>
											<Tooltip>
												<TooltipTrigger render={<span className="inline-flex" />}>
													<Switch
														aria-label={`${mapping.enabled ? "Disable" : "Enable"} ${mapping.name}`}
														checked={mapping.enabled}
														onCheckedChange={() =>
															void toggle.run(mapping.id, mapping)
														}
														disabled={toggle.isPending(mapping.id)}
													/>
												</TooltipTrigger>
												<TooltipContent>
													Added {formatRelativeTime(mapping.created_at)}
												</TooltipContent>
											</Tooltip>
										</div>
									</div>
								)
							})}
						</div>
					)}
				</div>
			</SettingsSection>

			{/* Add / Edit Dialog */}
			<FormDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editing ? "Edit attribute mapping" : "Add attribute mapping"}
				description="The value at the source key is written to the target span attribute. An existing target key is never overwritten."
				onSubmit={() => void handleSave()}
				submitLabel={editing ? "Save changes" : "Add mapping"}
				pending={isSaving}
				submitDisabled={!formValid}
			>
				<Field>
					<FieldLabel htmlFor="mapping-name">Name</FieldLabel>
					<Input
						id="mapping-name"
						placeholder="e.g. Normalize HTTP status code"
						value={formName}
						onChange={(e) => setFormName(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel>Source context</FieldLabel>
					<Select
						items={SOURCE_CONTEXT_LABELS}
						value={formSourceContext}
						onValueChange={(val: string | null) => setFormSourceContext(toSourceContext(val))}
					>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select source context">
								{(value: string | null) => {
									const ctx = value === null ? formSourceContext : toSourceContext(value)
									const Icon = SOURCE_CONTEXT_ICON[ctx]
									return (
										<span className="flex items-center gap-2">
											<Icon className="text-muted-foreground" />
											{SOURCE_CONTEXT_LABELS[ctx]}
										</span>
									)
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="span">
								<span className="flex items-center gap-2">
									<BracketsCurlyIcon className="text-muted-foreground" />
									Span attribute
								</span>
							</SelectItem>
							<SelectItem value="resource">
								<span className="flex items-center gap-2">
									<CubeIcon className="text-muted-foreground" />
									Resource attribute
								</span>
							</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field>
					<FieldLabel htmlFor="mapping-source-key">Source key</FieldLabel>
					<AttributeKeyAutocomplete
						id="mapping-source-key"
						scope={formSourceContext}
						placeholder="e.g. http.status_code"
						value={formSourceKey}
						onValueChange={setFormSourceKey}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="mapping-target-key">Target span attribute key</FieldLabel>
					<AttributeKeyAutocomplete
						id="mapping-target-key"
						scope="span"
						placeholder="e.g. http.response.status_code"
						value={formTargetKey}
						onValueChange={setFormTargetKey}
					/>
				</Field>
				<Field>
					<FieldLabel>Operation</FieldLabel>
					<Select
						items={OPERATION_LABELS}
						value={formOperation}
						onValueChange={(val: string | null) => setFormOperation(toOperation(val))}
					>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select operation">
								{(value: string | null) => {
									const op = value === null ? formOperation : toOperation(value)
									const meta = OPERATION_BADGE[op]
									const Icon = meta.icon
									return (
										<span className="flex items-center gap-2">
											<Icon className={meta.tone} />
											{OPERATION_LABELS[op]}
										</span>
									)
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="copy">
								<span className="flex items-center gap-2">
									<CopyIcon className={TONE_TEXT.info} />
									<span>
										Copy <span className="text-muted-foreground">(keep source key)</span>
									</span>
								</span>
							</SelectItem>
							<SelectItem value="move">
								<span className="flex items-center gap-2">
									<ArrowRightFromLineIcon className={TONE_TEXT.warn} />
									<span>
										Move{" "}
										<span className="text-muted-foreground">(remove source key)</span>
									</span>
								</span>
							</SelectItem>
						</SelectContent>
					</Select>
					{formSourceContext === "resource" && formOperation === "move" && (
						<FieldDescription>
							Move behaves as Copy for resource attributes: a resource attribute is shared
							across every span in a batch and is never deleted.
						</FieldDescription>
					)}
				</Field>

				{showPreview && (
					<Panel tone="muted" className="px-3 py-2.5">
						<Eyebrow className="mb-1.5" as="div">
							Preview
						</Eyebrow>
						<div className="flex flex-wrap items-center gap-1.5 text-sm">
							<InlineCode variant="plain">{formSourceKey.trim()}</InlineCode>
							<ArrowRightIcon size={12} className="text-muted-foreground shrink-0" />
							<InlineCode variant="plain" className="text-foreground">
								{formTargetKey.trim()}
							</InlineCode>
							<Badge variant={OPERATION_BADGE[formOperation].variant} className="ml-1 gap-1">
								<PreviewOpIcon size={11} />
								{OPERATION_LABELS[formOperation]}
							</Badge>
						</div>
					</Panel>
				)}
			</FormDialog>

			{/* Delete Confirmation */}
			<ConfirmDialog
				open={deleteConfirm !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(null)
				}}
				title="Delete attribute mapping?"
				description={
					<>
						Are you sure you want to delete{" "}
						<span className="text-foreground font-medium">{deleteConfirm?.name}</span>? This
						action cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={() => (deleteConfirm ? handleDelete(deleteConfirm.id) : undefined)}
			/>
		</>
	)
}
