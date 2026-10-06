import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { toastManager } from "@maple/ui/components/ui/toast"
import { cn } from "@maple/ui/lib/utils"
import { UploadIcon } from "@/components/icons"

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif"

interface ImageDropzoneProps {
	/** The current image (avatar, logo) rendered inside the square drop target. */
	preview: ReactNode
	/** Receives a file that already passed the image-type and size checks. */
	onFile: (file: File) => void
	/** Renders a "Remove" action when provided. */
	onRemove?: () => void
	uploading: boolean
	disabled?: boolean
	maxBytes?: number
	/** `accept` attribute for the file picker. */
	accept?: string
	/** Accessible name of the drop target, e.g. "Change profile picture". */
	targetLabel: string
	/** Label of the upload button, e.g. "Change picture". */
	changeLabel: string
	hint?: ReactNode
}

/** Square click-or-drop image target with upload/remove actions, shared by avatar and logo settings. */
export function ImageDropzone({
	preview,
	onFile,
	onRemove,
	uploading,
	disabled = false,
	maxBytes = DEFAULT_MAX_BYTES,
	accept = DEFAULT_ACCEPT,
	targetLabel,
	changeLabel,
	hint = "Drop an image or click to upload. PNG, JPG, WEBP or GIF, up to 10 MB.",
}: ImageDropzoneProps) {
	const [isDragging, setIsDragging] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const interactive = !disabled && !uploading

	function selectFile(file: File | undefined | null) {
		if (!interactive || !file) return
		if (!file.type.startsWith("image/")) {
			toastManager.add({ title: "Please choose an image file", type: "error" })
			return
		}
		if (file.size > maxBytes) {
			toastManager.add({
				title: `Image must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller`,
				type: "error",
			})
			return
		}
		onFile(file)
	}

	function openFilePicker() {
		if (!interactive) return
		fileInputRef.current?.click()
	}

	function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault()
			openFilePicker()
		}
	}

	function handleDrop(e: DragEvent<HTMLDivElement>) {
		e.preventDefault()
		setIsDragging(false)
		selectFile(e.dataTransfer.files?.[0])
	}

	return (
		<div className="flex items-center gap-4">
			<div
				role="button"
				tabIndex={interactive ? 0 : -1}
				aria-label={targetLabel}
				aria-disabled={!interactive}
				onClick={openFilePicker}
				onKeyDown={handleKeyDown}
				onDragOver={(e) => {
					e.preventDefault()
					if (interactive) setIsDragging(true)
				}}
				onDragLeave={() => setIsDragging(false)}
				onDrop={handleDrop}
				className={cn(
					"relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed p-1 outline-none transition-colors",
					interactive
						? "cursor-pointer hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
						: "cursor-not-allowed opacity-60",
					isDragging ? "border-primary ring-2 ring-primary" : "border-border",
				)}
			>
				{preview}
				{isDragging && (
					<div className="absolute inset-0 flex items-center justify-center rounded-md bg-primary/10 text-center text-3xs font-medium text-primary">
						Drop image
					</div>
				)}
			</div>
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={openFilePicker}
						loading={uploading}
						disabled={disabled}
					>
						<UploadIcon size={14} className="mr-1.5" />
						{changeLabel}
					</Button>
					{onRemove && (
						<Button variant="ghost" size="sm" onClick={onRemove} disabled={!interactive}>
							Remove
						</Button>
					)}
				</div>
				{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			</div>
			<input
				ref={fileInputRef}
				type="file"
				accept={accept}
				className="hidden"
				onChange={(e) => {
					const file = e.target.files?.[0]
					// Reset so picking the same file again still fires onChange.
					e.target.value = ""
					selectFile(file)
				}}
			/>
		</div>
	)
}

interface TypeToConfirmFieldProps {
	id: string
	/** The exact string the user must type back. */
	expected: string
	value: string
	onChange: (value: string) => void
}

/** "Type X to confirm." body for destructive ConfirmDialogs. */
export function TypeToConfirmField({ id, expected, value, onChange }: TypeToConfirmFieldProps) {
	return (
		// AlertDialog has no panel slot, so a body between header and footer pads itself.
		<div className="space-y-2">
			<Label htmlFor={id} className="text-xs">
				Type <span className="font-mono font-semibold">{expected}</span> to confirm.
			</Label>
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={expected}
				autoComplete="off"
			/>
		</div>
	)
}
