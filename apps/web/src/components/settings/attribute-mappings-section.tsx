import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type {
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
} from "@maple/domain/http"
import type { V2AttributeMapping } from "@maple/domain/http/v2"
import { useState } from "react"
import { Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"

import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
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
import { useAsyncAction } from "@/hooks/use-mutation-action"

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

export function AttributeMappingsSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [togglingId, setTogglingId] = useState<IngestAttributeMappingId | null>(null)
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

	const [handleSave, isSaving] = useAsyncAction(async () => {
		if (!formName.trim() || !formSourceKey.trim() || !formTargetKey.trim()) {
			toastManager.add({ title: "Name, source key, and target key are required", type: "error" })
			return
		}

		if (editing) {
			const result = await updateMutation({
				params: { id: editing.id },
				payload: {
					name: formName.trim(),
					source_context: formSourceContext,
					source_key: formSourceKey.trim(),
					target_key: formTargetKey.trim(),
					operation: formOperation,
				},
			})
			if (Exit.isSuccess(result)) {
				toastManager.add({ title: "Attribute mapping updated", type: "success" })
				setDialogOpen(false)
				refreshMappings()
				refreshRecommendations()
			} else {
				toastManager.add({ title: "Failed to update attribute mapping", type: "error" })
			}
		} else {
			const result = await createMutation({
				payload: {
					name: formName.trim(),
					source_context: formSourceContext,
					source_key: formSourceKey.trim(),
					target_key: formTargetKey.trim(),
					operation: formOperation,
				},
			})
			if (Exit.isSuccess(result)) {
				toastManager.add({ title: "Attribute mapping created", type: "success" })
				setDialogOpen(false)
				refreshMappings()
				refreshRecommendations()
			} else {
				toastManager.add({ title: "Failed to create attribute mapping", type: "error" })
			}
		}
	})

	async function handleDelete(mappingId: IngestAttributeMappingId) {
		setDeleteConfirm(null)
		const result = await deleteMutation({ params: { id: mappingId } })
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: "Attribute mapping deleted", type: "success" })
			refreshMappings()
			refreshRecommendations()
		} else {
			toastManager.add({ title: "Failed to delete attribute mapping", type: "error" })
		}
	}

	async function handleToggleEnabled(mapping: V2AttributeMapping) {
		setTogglingId(mapping.id)
		const result = await updateMutation({
			params: { id: mapping.id },
			payload: {
				enabled: !mapping.enabled,
			},
		})
		if (Exit.isSuccess(result)) {
			refreshMappings()
		} else {
			toastManager.add({ title: "Failed to update attribute mapping", type: "error" })
		}
		setTogglingId(null)
	}

	const mappingCount = Result.isSuccess(listResult) ? mappings.length : null

	const PreviewOpIcon = OPERATION_BADGE[formOperation].icon
	const showPreview = formSourceKey.trim().length > 0 && formTargetKey.trim().length > 0

	return (
		<>
			<Card className="overflow-hidden">
				<CardHeader className="px-4 pt-4 pb-3">
					<CardTitle render={<h3 />} className="text-sm font-medium">
						Attribute mappings
						{mappingCount !== null && mappingCount > 0 && (
							<span className="text-muted-foreground font-normal tabular-nums">
								{" "}
								· {mappingCount}
							</span>
						)}
					</CardTitle>
					<CardDescription className="text-xs">
						Rename or promote span attribute keys at ingest. Applied only to spans received after
						a rule is saved.
					</CardDescription>
					<CardAction>
						<Button variant="outline" size="sm" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add mapping
						</Button>
					</CardAction>
				</CardHeader>
				<div className="border-t">
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
									<PlusIcon size={14} />
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
										<span className="w-44 shrink-0 truncate text-sm" title={mapping.name}>
											{mapping.name}
										</span>

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
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-foreground"
													onClick={() => openEditDialog(mapping)}
													aria-label="Edit mapping"
													title="Edit"
												>
													<PencilIcon size={14} />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-destructive"
													onClick={() => setDeleteConfirm(mapping)}
													aria-label="Delete mapping"
													title="Delete"
												>
													<TrashIcon size={14} />
												</Button>
											</div>
											<Switch
												checked={mapping.enabled}
												onCheckedChange={() => handleToggleEnabled(mapping)}
												disabled={togglingId === mapping.id}
												title={`Added ${formatRelativeTime(mapping.created_at)}`}
											/>
										</div>
									</div>
								)
							})}
						</div>
					)}
				</div>
			</Card>

			{/* Add / Edit Dialog */}
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
							<ArrowUpDownIcon size={18} />
						</div>
						<DialogTitle>
							{editing ? "Edit Attribute Mapping" : "Add Attribute Mapping"}
						</DialogTitle>
						<DialogDescription>
							The value at the source key is written to the target span attribute. An existing
							target key is never overwritten.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6 py-2">
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
								onValueChange={(val: string | null) =>
									setFormSourceContext((val as IngestMappingSourceContext | null) ?? "span")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select source context">
										{(value: string | null) => {
											const ctx =
												(value as IngestMappingSourceContext | null) ??
												formSourceContext
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
								onValueChange={(val: string | null) =>
									setFormOperation((val as IngestMappingOperation | null) ?? "copy")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select operation">
										{(value: string | null) => {
											const op =
												(value as IngestMappingOperation | null) ?? formOperation
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
												Copy{" "}
												<span className="text-muted-foreground">
													— keep source key
												</span>
											</span>
										</span>
									</SelectItem>
									<SelectItem value="move">
										<span className="flex items-center gap-2">
											<ArrowRightFromLineIcon className={TONE_TEXT.warn} />
											<span>
												Move{" "}
												<span className="text-muted-foreground">
													— remove source key
												</span>
											</span>
										</span>
									</SelectItem>
								</SelectContent>
							</Select>
							{formSourceContext === "resource" && formOperation === "move" && (
								<p className="text-muted-foreground text-xs">
									Move behaves as Copy for resource attributes — a resource attribute is
									shared across every span in a batch and is never deleted.
								</p>
							)}
						</Field>

						{showPreview && (
							<div className="rounded-md border bg-muted/40 px-3 py-2.5">
								<Eyebrow className="mb-1.5" as="div">
									Preview
								</Eyebrow>
								<div className="flex flex-wrap items-center gap-1.5 text-sm">
									<InlineCode variant="plain">{formSourceKey.trim()}</InlineCode>
									<ArrowRightIcon size={12} className="text-muted-foreground shrink-0" />
									<InlineCode variant="plain" className="text-foreground">
										{formTargetKey.trim()}
									</InlineCode>
									<Badge
										variant={OPERATION_BADGE[formOperation].variant}
										className="ml-1 gap-1"
									>
										<PreviewOpIcon size={11} />
										{OPERATION_LABELS[formOperation]}
									</Badge>
								</div>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
							Cancel
						</Button>
						<Button onClick={handleSave} loading={isSaving}>
							{editing ? "Save Changes" : "Add Mapping"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation */}
			<ConfirmDialog
				open={deleteConfirm !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(null)
				}}
				title="Delete attribute mapping"
				description={
					<>
						Are you sure you want to delete{" "}
						<span className="text-foreground font-medium">{deleteConfirm?.name}</span>? This
						action cannot be undone.
					</>
				}
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleteConfirm) void handleDelete(deleteConfirm.id)
				}}
			/>
		</>
	)
}
