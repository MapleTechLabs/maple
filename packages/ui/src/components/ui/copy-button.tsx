"use client"

import { Option } from "effect"

import { trySync } from "../../lib/try-sync"
import * as React from "react"

import { useCopy, type CopyStatus, type UseCopyOptions } from "../../hooks/use-copy"
import { cn } from "../../lib/utils"
import { CopyIcon, type IconComponent } from "../icons"
import { Button, type ButtonProps } from "./button"
import {
	copyButtonStatusStyles,
	copyButtonStyles,
	copyIndicatorCheckDrawStyles,
	copyIndicatorCopiedStyles,
	copyIndicatorErrorStyles,
	copyIndicatorFullStrengthStyles,
	copyIndicatorLayerActiveStyles,
	copyIndicatorLayerStyles,
	copyIndicatorStyles,
	copyLabelActiveStyles,
	copyLabelLayerStyles,
	copyLabelStyles,
} from "./copy-button.styles"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip"

/**
 * The house icon set is dotted-outline, so only the check is drawable — it's the
 * one glyph in the set (see `circle-check.tsx`) built from a single continuous
 * path. Sized to span the same 4–20 box the dotted icons do, so it doesn't read
 * as smaller than the copy glyph it replaces.
 */
const CHECK_PATH = "M4.5 12.5L9.5 17.5L19.5 6.5"

export interface CopyTooltipLabels {
	copiedLabel?: string
	/** Failure wording, used verbatim inline and in the tooltip. Left unset,
	 *  the inline label is a compact "Failed" and the tooltip the full
	 *  sentence, so the button is not sized to a state it is almost never in. */
	errorLabel?: string
}

/**
 * The wording every copy tooltip shares. Lives here rather than inline in each
 * component so `CopyButton` and `CopyableBadge` can't drift on it.
 */
export function copyTooltipText(
	status: CopyStatus,
	label: string,
	{ copiedLabel = "Copied", errorLabel = "Couldn't copy" }: CopyTooltipLabels = {},
): string {
	if (status === "copied") return copiedLabel
	if (status === "error") return errorLabel
	return `Copy ${label}`
}

export interface CopyIndicatorProps {
	status: CopyStatus
	/** Glyph size in px, the same `iconSize` that `CopyButton` takes. */
	iconSize?: number
	/** Icon for the resting state — pass `LinkIcon` for share-a-URL affordances,
	 * or whatever else the callsite is copying. Only the idle glyph is the
	 * callsite's to pick; the success check and failure X are fixed. */
	idleIcon?: IconComponent
	className?: string
}

/**
 * The three-state copy glyph: resting icon, a check that *draws* itself on
 * success, and an X on failure. All three occupy one grid cell so swapping
 * states never reflows the row.
 *
 * Exported on its own for surfaces that can't use `CopyButton` — dropdown menu
 * items, chips, and anything already wrapped in its own trigger. Standalone it
 * carries its own `group/copy`, so it animates whether or not a `CopyButton` is
 * above it.
 */
export function CopyIndicator({
	status,
	iconSize = 14,
	idleIcon: Idle = CopyIcon,
	className,
}: CopyIndicatorProps): React.ReactElement {
	return (
		<span
			aria-hidden="true"
			data-copy-status={status}
			className={cn(copyIndicatorStyles, className)}
			style={{ height: iconSize, width: iconSize }}
		>
			<span className={cn(copyIndicatorLayerStyles, copyIndicatorLayerActiveStyles.idle)}>
				<Idle size={iconSize} />
			</span>

			<span
				className={cn(
					copyIndicatorLayerStyles,
					copyIndicatorLayerActiveStyles.copied,
					copyIndicatorCopiedStyles,
				)}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					width={iconSize}
					height={iconSize}
					fill="none"
					aria-hidden="true"
					className={copyIndicatorFullStrengthStyles}
				>
					<path
						d={CHECK_PATH}
						pathLength={1}
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
						className={copyIndicatorCheckDrawStyles}
					/>
				</svg>
			</span>

			<span
				className={cn(
					copyIndicatorLayerStyles,
					copyIndicatorLayerActiveStyles.error,
					copyIndicatorErrorStyles,
				)}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					width={iconSize}
					height={iconSize}
					fill="none"
					aria-hidden="true"
					className={copyIndicatorFullStrengthStyles}
				>
					<path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
					<path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
				</svg>
			</span>
		</span>
	)
}

/**
 * Label that crossfades between the three states. Every string is stacked in
 * the same grid cell, so the button is sized to the longest one up front and
 * never jumps width mid-animation. Reads the status off the `group/copy` its
 * `CopyButton` puts on the button element.
 */
function CopyLabel({ labels }: { labels: ReadonlyArray<readonly [CopyStatus, string]> }): React.ReactElement {
	return (
		<span aria-hidden="true" className={copyLabelStyles}>
			{labels.map(([key, text]) => (
				<span key={key} className={cn(copyLabelLayerStyles, copyLabelActiveStyles[key])}>
					{text}
				</span>
			))}
		</span>
	)
}

export interface CopyButtonProps
	extends
		Omit<ButtonProps, "children" | "onCopy" | "onError" | "value">,
		Pick<UseCopyOptions, "timeout" | "toast" | "successMessage" | "onCopy" | "onError"> {
	/** What lands on the clipboard. Pass a thunk when building it is expensive. */
	value: string | (() => string)
	/** Human name for the thing being copied — drives `aria-label` and toasts. */
	label: string
	/** Text shown next to the glyph while resting. Passing it is what turns the
	 * animated text label on; glyph-only is the default. */
	idleLabel?: string
	copiedLabel?: string
	errorLabel?: string
	/** Wrap in a tooltip whose text follows the copy status. */
	tooltip?: boolean
	/** Sonner feedback; on by default. See `useCopy`. */
	toast?: boolean
	/** Glyph size in px. Defaults to 14 to match the icon buttons it replaces. */
	iconSize?: number
	/** Resting glyph. Defaults to the copy icon; pass `LinkIcon` (or any icon)
	 * when the thing being copied reads as something else. */
	idleIcon?: IconComponent
}

/** Resolve a lazy `value` without letting a throwing resolver (a circular
 * `JSON.stringify`, say) escape as an uncaught click handler error. */
function resolveValue(value: string | (() => string)): string | null {
	if (typeof value !== "function") return value
	return Option.getOrNull(trySync(value))
}

/**
 * The one copy affordance. Built on `Button`, so every variant, size, pressed
 * state, focus ring, and the `render` polymorphism come along unchanged —
 * motion is scoped to the glyph. Toasts by default; the drawn check is the
 * immediate, in-place confirmation on top of that. Pass `toast={false}` only
 * where a toast per click would pile up.
 */
export function CopyButton({
	value,
	label,
	idleLabel,
	copiedLabel = "Copied",
	errorLabel,
	tooltip,
	iconSize = 14,
	idleIcon,
	timeout,
	toast,
	successMessage,
	onCopy,
	onError,
	variant = "ghost",
	size,
	className,
	onClick,
	...props
}: CopyButtonProps): React.ReactElement {
	const { copy, status } = useCopy({ label, onCopy, onError, successMessage, timeout, toast })
	const withLabel = idleLabel !== undefined
	const resolvedSize = size ?? (withLabel ? "sm" : "icon-xs")

	/**
	 * The three inline labels are stacked, so the button reserves the widest of
	 * them for good — and a full "Failed to copy" beside a resting "Copy" is a
	 * button three times wider than the word it shows, all of it dead space in
	 * the state it sits in essentially always. Inline the failure reads fine as
	 * one word; the tooltip, the toast and the live region keep the sentence. A
	 * callsite that passes its own `errorLabel` gets it verbatim in both.
	 */
	const inlineErrorLabel = errorLabel ?? "Failed"
	const errorText = errorLabel ?? "Couldn't copy"

	const button = (
		<Button
			aria-label={`Copy ${label}`}
			variant={variant}
			size={resolvedSize}
			data-copy-status={status}
			className={cn(copyButtonStyles, className)}
			onClick={(event) => {
				onClick?.(event)
				if (event.defaultPrevented) return
				void copy(resolveValue(value))
			}}
			{...props}
		>
			<CopyIndicator status={status} iconSize={iconSize} idleIcon={idleIcon} />
			{withLabel && (
				<CopyLabel
					labels={[
						["idle", idleLabel],
						["copied", copiedLabel],
						["error", inlineErrorLabel],
					]}
				/>
			)}
			<span role="status" aria-live="polite" className={copyButtonStatusStyles}>
				{status === "copied" ? copiedLabel : status === "error" ? errorText : ""}
			</span>
		</Button>
	)

	if (!tooltip) return button

	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipPopup>
				{copyTooltipText(status, label, { copiedLabel, errorLabel: errorText })}
			</TooltipPopup>
		</Tooltip>
	)
}
