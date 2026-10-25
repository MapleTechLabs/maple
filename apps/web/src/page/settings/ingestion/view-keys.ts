import { cn } from "@maple/ui/lib/utils"
import { REPLAY_BLOCK_CLASS } from "../../../components/common/replay-privacy"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { maskKey } from "../../../ui/copyable-field"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { skeleton } from "../../../ui/skeleton"
import { Message } from "./message"
import type { IngestKeyKind, Model } from "./model"

// `CredentialRow`.

type H = HtmlBuilder<Message>

export type CredentialRowOptions = Readonly<{
	label: string
	badge: string
	badgeClass: string
	/** `null` while the value is still loading (or failed to, with `isFailed`: the group shows the error). */
	value: string | null
	isFailed?: boolean
	isMasked?: boolean
	description?: string
	isVisible?: boolean
	onToggleVisibility?: Message
	copy: CopyButton.Model
	onCopy: (text: string) => Message
	onRegenerate?: Message
	isDisabled?: boolean
}>

/** One copy state drives the inline value and the trailing button, so they never disagree. */
export const credentialRow = (h: H, options: CredentialRowOptions): Html => {
	const { label, value } = options
	const isMasked = options.isMasked ?? false
	const isVisible = options.isVisible ?? false
	const disabled = options.isDisabled ?? false
	const isDisabled = disabled || value === null
	const status = options.copy.status
	const isHidden = isMasked && !isVisible
	const copyAttributes = value === null ? [] : [h.OnClick(options.onCopy(value))]
	const isUnknown = value === null && options.isFailed === true
	const valueCell = isUnknown
		? []
		: [
				value === null
					? skeleton(h, "h-4 w-40 max-w-full")
					: h.button(
							[
								h.Type("button"),
								...copyAttributes,
								...(isDisabled ? [h.Disabled(true)] : []),
								h.AriaLabel(`Copy ${label}`),
								// A revealed key is plain text, which the dashboard's own rrweb recording would capture.
								h.Class(
									cn(
										isMasked && REPLAY_BLOCK_CLASS,
										"group/value text-muted-foreground hover:text-foreground flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left font-mono text-xs tracking-wide transition-colors",
									),
								),
							],
							[
								h.span(
									[h.Class(isHidden ? "truncate" : "min-w-0 break-all")],
									[isHidden ? maskKey(value) : value],
								),
								CopyButton.copyIndicator(h, {
									status,
									iconSize: 12,
									className: cn(
										"shrink-0 transition-opacity group-hover/value:opacity-100",
										status === "idle" && "opacity-0",
									),
								}),
							],
						),
			]
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap")],
		[
			h.span([h.Class("w-full shrink-0 text-sm sm:w-[120px]")], [label]),
			eyebrow(
				h,
				{ variant: "mono", className: cn("hidden w-14 shrink-0 sm:block", options.badgeClass) },
				[options.badge],
			),
			h.div(
				[h.Class("flex min-w-0 grow basis-0 flex-col items-start gap-0.5")],
				[
					...valueCell,
					...(options.description
						? [
								h.span(
									[h.Class("text-muted-foreground/70 text-2xs leading-3.5")],
									[options.description],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-1.5")],
				// Nothing to copy, reveal or rotate while the key is unknown.
				isUnknown
					? []
					: [
							...(options.onToggleVisibility === undefined
								? []
								: [
										iconButton(
											h,
											{
												variant: "outline",
												label: isVisible ? "Hide key" : "Reveal key",
												isDisabled,
												attributes: [h.OnClick(options.onToggleVisibility)],
											},
											[
												icon(h, "EyeIcon", {
													className: isVisible
														? "text-foreground"
														: "text-muted-foreground",
												}),
											],
										),
									]),
							iconButton(
								h,
								{
									variant: "outline",
									label: `Copy ${label}`,
									isDisabled,
									attributes: copyAttributes,
								},
								[CopyButton.copyIndicator(h, { status, iconSize: 13 })],
							),
							...(options.onRegenerate === undefined
								? []
								: [
										iconButton(
											h,
											{
												variant: "outline",
												label: `Regenerate ${label.toLowerCase()}`,
												isDisabled: disabled,
												attributes: [h.OnClick(options.onRegenerate)],
											},
											[icon(h, "ArrowPathIcon", { className: "text-destructive" })],
										),
									]),
						],
			),
		],
	)
}

/** `IngestKeyRows`: the org's pair, masked until revealed. Admin-only. */
export const ingestKeyRows = (h: H, model: Model): ReadonlyArray<Html> => {
	// Only Success (incl. waiting) has keys; a failed refetch drops them.
	const hasKeys = AsyncData.isSuccess(model.ingest) || AsyncData.isRefreshing(model.ingest)
	const keys = hasKeys ? AsyncData.getOrElse(model.ingest, () => null) : null
	const isFailed = AsyncData.isFailure(model.ingest) || AsyncData.isStale(model.ingest)
	const isBusy = !hasKeys || model.isRolling
	const row = (
		kind: IngestKeyKind,
		label: string,
		badge: string,
		badgeClass: string,
		description: string,
	) =>
		credentialRow(h, {
			label,
			badge,
			badgeClass,
			value: keys === null ? null : kind === "public" ? keys.public_key : keys.private_key,
			isFailed,
			isMasked: true,
			description,
			isVisible: model.revealedKeys.includes(kind),
			onToggleVisibility: Message.ToggledKeyReveal({ kind }),
			copy: model.keyCopies[kind] ?? CopyButton.init(),
			onCopy: (text) =>
				Message.GotKeyCopyMessage({ kind, message: CopyButton.Message.ClickedCopy({ text }) }),
			onRegenerate: Message.ClickedRegenerateKey({ kind }),
			isDisabled: isBusy,
		})
	const failure = keys === null && isFailed ? AsyncData.getError(model.ingest) : Option.none()
	return [
		row("public", "Public key", "Client", "text-info", "For browser and client-side telemetry SDKs"),
		row(
			"private",
			"Private key",
			"Server",
			"text-warning",
			"For server-side ingestion and backend services",
		),
		// One error for the pair, not one per row.
		...Option.match(failure, {
			onNone: () => [],
			onSome: (error) => [
				errorState(h, {
					variant: "quiet",
					failure: error,
					title: "Couldn't load the ingest keys",
					onRetry: Message.ClickedRetryIngestKeys(),
					className: "px-4 py-2.5",
				}),
			],
		}),
	]
}
