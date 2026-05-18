import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	CreateIngestAttributeMappingRequest,
	UpdateIngestAttributeMappingRequest,
} from "@maple/domain/http"
import type {
	IngestAttributeMapping,
	IngestAttributeMappingId,
	IngestMappingOperation,
	IngestMappingSourceContext,
} from "@maple/domain/http"
import { useState } from "react"
import { Exit } from "effect"
import { toast } from "sonner"

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@maple/ui/components/ui/card"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import {
	AlertWarningIcon,
	ArrowPathIcon,
	ArrowRightIcon,
	ArrowUpDownIcon,
	DotsVerticalIcon,
	LoaderIcon,
	PencilIcon,
	PlusIcon,
	TrashIcon,
} from "@/components/icons"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const SOURCE_CONTEXT_LABELS: Record<IngestMappingSourceContext, string> = {
	span: "Span attribute",
	resource: "Resource attribute",
}

const OPERATION_LABELS: Record<IngestMappingOperation, string> = {
	move: "Move",
	copy: "Copy",
}

export function AttributeMappingsSection() {
	const [dialogOpen, setDialogOpen] = useState(false)
	const [isSaving, setIsSaving] = useState(false)
	const [togglingId, setTogglingId] = useState<IngestAttributeMappingId | null>(null)
	const [deleteConfirm, setDeleteConfirm] = useState<IngestAttributeMapping | null>(null)

	const [editing, setEditing] = useState<IngestAttributeMapping | null>(null)
	const [formName, setFormName] = useState("")
	const [formSourceContext, setFormSourceContext] = useState<IngestMappingSourceContext>("span")
	const [formSourceKey, setFormSourceKey] = useState("")
	const [formTargetKey, setFormTargetKey] = useState("")
	const [formOperation, setFormOperation] = useState<IngestMappingOperation>("copy")

	const listQueryAtom = MapleApiAtomClient.query("ingestAttributeMappings", "list", {})
	const listResult = useAtomValue(listQueryAtom)
	const refreshMappings = useAtomRefresh(listQueryAtom)

	const createMutation = useAtomSet(MapleApiAtomClient.mutation("ingestAttributeMappings", "create"), {
		mode: "promiseExit",
	})
	const updateMutation = useAtomSet(MapleApiAtomClient.mutation("ingestAttributeMappings", "update"), {
		mode: "promiseExit",
	})
	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("ingestAttributeMappings", "delete"), {
		mode: "promiseExit",
	})

	const mappings = Result.builder(listResult)
		.onSuccess((response) => [...response.mappings])
		.orElse(() => [] as IngestAttributeMapping[])

	function openAddDialog() {
		setEditing(null)
		setFormName("")
		setFormSourceContext("span")
		setFormSourceKey("")
		setFormTargetKey("")
		setFormOperation("copy")
		setDialogOpen(true)
	}

	function openEditDialog(mapping: IngestAttributeMapping) {
		setEditing(mapping)
		setFormName(mapping.name)
		setFormSourceContext(mapping.sourceContext)
		setFormSourceKey(mapping.sourceKey)
		setFormTargetKey(mapping.targetKey)
		setFormOperation(mapping.operation)
		setDialogOpen(true)
	}

	async function handleSave() {
		if (!formName.trim() || !formSourceKey.trim() || !formTargetKey.trim()) {
			toast.error("Name, source key, and target key are required")
			return
		}

		setIsSaving(true)
		if (editing) {
			const result = await updateMutation({
				params: { mappingId: editing.id },
				payload: new UpdateIngestAttributeMappingRequest({
					name: formName.trim(),
					sourceContext: formSourceContext,
					sourceKey: formSourceKey.trim(),
					targetKey: formTargetKey.trim(),
					operation: formOperation,
				}),
			})
			if (Exit.isSuccess(result)) {
				toast.success("Attribute mapping updated")
				setDialogOpen(false)
				refreshMappings()
			} else {
				toast.error("Failed to update attribute mapping")
			}
		} else {
			const result = await createMutation({
				payload: new CreateIngestAttributeMappingRequest({
					name: formName.trim(),
					sourceContext: formSourceContext,
					sourceKey: formSourceKey.trim(),
					targetKey: formTargetKey.trim(),
					operation: formOperation,
				}),
			})
			if (Exit.isSuccess(result)) {
				toast.success("Attribute mapping created")
				setDialogOpen(false)
				refreshMappings()
			} else {
				toast.error("Failed to create attribute mapping")
			}
		}
		setIsSaving(false)
	}

	async function handleDelete(mappingId: IngestAttributeMappingId) {
		setDeleteConfirm(null)
		const result = await deleteMutation({ params: { mappingId } })
		if (Exit.isSuccess(result)) {
			toast.success("Attribute mapping deleted")
			refreshMappings()
		} else {
			toast.error("Failed to delete attribute mapping")
		}
	}

	async function handleToggleEnabled(mapping: IngestAttributeMapping) {
		setTogglingId(mapping.id)
		const result = await updateMutation({
			params: { mappingId: mapping.id },
			payload: new UpdateIngestAttributeMappingRequest({
				enabled: !mapping.enabled,
			}),
		})
		if (Exit.isSuccess(result)) {
			refreshMappings()
		} else {
			toast.error("Failed to update attribute mapping")
		}
		setTogglingId(null)
	}

	const mappingCount = Result.isSuccess(listResult) ? mappings.length : null

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						Attribute Mappings
						{mappingCount !== null && mappingCount > 0 && (
							<Badge variant="secondary" className="font-normal tabular-nums">
								{mappingCount}
							</Badge>
						)}
					</CardTitle>
					<CardDescription>
						Rename or promote span attribute keys at ingest so telemetry from different SDKs
						stays consistent. Applied only to spans received after a rule is saved.
					</CardDescription>
					<CardAction>
						<Button size="sm" onClick={openAddDialog}>
							<PlusIcon size={14} />
							Add Mapping
						</Button>
					</CardAction>
				</CardHeader>
				<CardContent>
					{Result.isInitial(listResult) ? (
						<div className="space-y-px">
							{[0, 1].map((i) => (
								<div key={i} className="flex items-center gap-4 py-3">
									<div className="flex-1 space-y-2">
										<Skeleton className="h-4 w-40" />
										<Skeleton className="h-3.5 w-64" />
									</div>
									<Skeleton className="h-5 w-9 rounded-full" />
								</div>
							))}
						</div>
					) : !Result.isSuccess(listResult) ? (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<AlertWarningIcon size={16} className="text-destructive" />
								</EmptyMedia>
								<EmptyTitle>Couldn't load mappings</EmptyTitle>
								<EmptyDescription>
									Something went wrong fetching your attribute mappings.
								</EmptyDescription>
							</EmptyHeader>
							<Button variant="outline" size="sm" onClick={() => refreshMappings()}>
								<ArrowPathIcon size={14} />
								Try again
							</Button>
						</Empty>
					) : mappings.length === 0 ? (
						<Empty className="py-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ArrowUpDownIcon size={16} />
								</EmptyMedia>
								<EmptyTitle>No attribute mappings yet</EmptyTitle>
								<EmptyDescription>
									Add a rule to rename or promote span attribute keys as telemetry is
									ingested.
								</EmptyDescription>
							</EmptyHeader>
							<Button size="sm" onClick={openAddDialog}>
								<PlusIcon size={14} />
								Add Mapping
							</Button>
						</Empty>
					) : (
						<div className="divide-border/60 divide-y">
							{mappings.map((mapping) => (
								<div
									key={mapping.id}
									className={cn(
										"flex items-center gap-4 py-3 first:pt-0 last:pb-0",
										!mapping.enabled && "opacity-55",
									)}
								>
									<div className="min-w-0 flex-1">
										<div className="mb-1.5 flex items-center gap-2">
											<span className="truncate text-sm font-medium">
												{mapping.name}
											</span>
											<Badge
												variant={mapping.operation === "move" ? "default" : "secondary"}
												className="shrink-0"
											>
												{OPERATION_LABELS[mapping.operation]}
											</Badge>
										</div>
										<div className="flex flex-wrap items-center gap-1.5 text-xs">
											<code className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-mono">
												{mapping.sourceKey}
											</code>
											<ArrowRightIcon
												size={12}
												className="text-muted-foreground shrink-0"
											/>
											<code className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-mono">
												{mapping.targetKey}
											</code>
											{mapping.sourceContext === "resource" && (
												<span className="text-muted-foreground">
													· from {SOURCE_CONTEXT_LABELS.resource.toLowerCase()}
												</span>
											)}
										</div>
									</div>

									<Switch
										checked={mapping.enabled}
										onCheckedChange={() => handleToggleEnabled(mapping)}
										disabled={togglingId === mapping.id}
									/>

									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-foreground shrink-0"
												/>
											}
										>
											<DotsVerticalIcon size={14} />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onClick={() => openEditDialog(mapping)}>
												<PencilIcon size={14} />
												Edit
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setDeleteConfirm(mapping)}
											>
												<TrashIcon size={14} />
												Delete
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Add / Edit Dialog */}
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{editing ? "Edit Attribute Mapping" : "Add Attribute Mapping"}</DialogTitle>
						<DialogDescription>
							The value at the source key is written to the target span attribute. An existing
							target key is never overwritten.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6 py-2">
						<div className="space-y-2">
							<Label htmlFor="mapping-name">Name</Label>
							<Input
								id="mapping-name"
								placeholder="e.g. Normalize HTTP status code"
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Source context</Label>
							<Select
								items={SOURCE_CONTEXT_LABELS}
								value={formSourceContext}
								onValueChange={(val: string | null) =>
									setFormSourceContext((val as IngestMappingSourceContext | null) ?? "span")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select source context" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="span">Span attribute</SelectItem>
									<SelectItem value="resource">Resource attribute</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mapping-source-key">Source key</Label>
							<Input
								id="mapping-source-key"
								placeholder="e.g. http.status_code"
								value={formSourceKey}
								onChange={(e) => setFormSourceKey(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mapping-target-key">Target span attribute key</Label>
							<Input
								id="mapping-target-key"
								placeholder="e.g. http.response.status_code"
								value={formTargetKey}
								onChange={(e) => setFormTargetKey(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Operation</Label>
							<Select
								items={OPERATION_LABELS}
								value={formOperation}
								onValueChange={(val: string | null) =>
									setFormOperation((val as IngestMappingOperation | null) ?? "copy")
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select operation" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="copy">Copy (keep source key)</SelectItem>
									<SelectItem value="move">Move (remove source key)</SelectItem>
								</SelectContent>
							</Select>
							{formSourceContext === "resource" && formOperation === "move" && (
								<p className="text-muted-foreground text-xs">
									Move behaves as Copy for resource attributes — a resource attribute is
									shared across every span in a batch and is never deleted.
								</p>
							)}
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
							Cancel
						</Button>
						<Button onClick={handleSave} disabled={isSaving}>
							{isSaving ? (
								<>
									<LoaderIcon size={14} className="animate-spin" />
									{editing ? "Saving..." : "Adding..."}
								</>
							) : editing ? (
								"Save Changes"
							) : (
								"Add Mapping"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation */}
			<AlertDialog
				open={deleteConfirm !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteConfirm(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete attribute mapping</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete{" "}
							<span className="text-foreground font-medium">{deleteConfirm?.name}</span>? This
							action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (deleteConfirm) {
									void handleDelete(deleteConfirm.id)
								}
							}}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
