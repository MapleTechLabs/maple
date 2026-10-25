import { cn } from "@maple/ui/lib/utils"
import {
	toastBodyStyles,
	toastContentStyles,
	toastDescriptionStyles,
	toastIconGlyphStyles,
	toastIconStyles,
	toastRootStyles,
	toastTextStyles,
	toastTitleStyles,
	toastViewportAnchoredStyles,
	toastViewportStyles,
} from "@maple/ui/styles/ui/toast"
import { Array, Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { icon, type IconName } from "./icon"
import {
	descriptionId,
	isExpanded,
	LIMIT,
	MeasureToast,
	Message,
	type Model,
	PortalToasts,
	titleId,
	type Toast,
	type ToastType,
} from "./toast"

// packages/ui/src/components/ui/toast.tsx `Toasts` and `AnchoredToasts`, position "bottom-right".
const POSITION = "bottom-right"

const ICONS = {
	error: "CircleXmarkIcon",
	info: "CircleInfoIcon",
	loading: "LoaderIcon",
	success: "CircleCheckIcon",
	warning: "AlertWarningIcon",
} as const satisfies Record<Exclude<ToastType, "default">, IconName>

/** The live-region attributes both Base UI viewports carry. */
const regionAttributes = <M>(h: HtmlBuilder<M>): ReadonlyArray<Attribute<M>> => [
	h.AriaAtomic(false),
	h.AriaLabel("Notifications"),
	h.AriaLive("polite"),
	h.AriaRelevant("additions text"),
]

const typeAttribute = <M>(h: HtmlBuilder<M>, type: ToastType): ReadonlyArray<Attribute<M>> =>
	type === "default" ? [] : [h.DataAttribute("type", type)]

const toastIcon = (h: HtmlBuilder<Message>, type: ToastType): ReadonlyArray<Html> =>
	type === "default"
		? []
		: [
				h.div(
					[h.Class(toastIconStyles), h.DataAttribute("slot", "toast-icon")],
					[icon(h, ICONS[type], { className: toastIconGlyphStyles })],
				),
			]

/** Base UI's toast metadata: stacking index among live toasts, offset from the heights before it. */
type Placement = Readonly<{ index: number; visibleIndex: number; offsetY: number; isLimited: boolean }>

const placements = (toasts: ReadonlyArray<Toast>): ReadonlyArray<Placement> =>
	Array.mapAccum(toasts, { visible: 0, offsetY: 0 }, (state, toast, index) => {
		const isEnding = toast.phase === "Ending"
		const placement = {
			index,
			visibleIndex: isEnding ? -1 : state.visible,
			offsetY: state.offsetY,
			isLimited: !isEnding && state.visible >= LIMIT,
		}
		return [
			{
				visible: isEnding ? state.visible : state.visible + 1,
				offsetY: state.offsetY + (toast.height ?? 0),
			},
			placement,
		]
	})[1]

/** The root's CSS variables; `--toast-height` only once the toast has been measured. */
const rootStyle = (toast: Toast, placement: Placement): Record<string, string> => {
	const style = {
		"--toast-swipe-movement-x": "0px",
		"--toast-swipe-movement-y": "0px",
		"--toast-index": String(toast.phase === "Ending" ? placement.index : placement.visibleIndex),
		"--toast-offset-y": `${placement.offsetY}px`,
	}
	return toast.height === null ? style : { ...style, "--toast-height": `${toast.height}px` }
}

const toastRoot = (h: HtmlBuilder<Message>, model: Model, toast: Toast, placement: Placement): Html => {
	const isExpandedNow = isExpanded(model)
	return h.div(
		[
			h.Key(toast.id),
			// Base UI's `Toast.Description` renders nothing for a toast without one.
			...(toast.description === "" ? [] : [h.AriaDescribedBy(descriptionId(toast.id))]),
			h.AriaLabelledBy(titleId(toast.id)),
			h.AriaModal(false),
			h.Class(cn(...toastRootStyles)),
			...(isExpandedNow ? [h.DataAttribute("expanded", "")] : []),
			...(placement.isLimited ? [h.DataAttribute("limited", ""), h.Inert(true)] : []),
			h.DataAttribute("position", POSITION),
			...(toast.phase === "Starting" ? [h.DataAttribute("starting-style", "")] : []),
			...(toast.phase === "Ending" ? [h.DataAttribute("ending-style", "")] : []),
			...typeAttribute(h, toast.type),
			h.Role("dialog"),
			h.Style(rootStyle(toast, placement)),
			h.Tabindex(0),
			h.OnMount(MeasureToast({ toastId: toast.id })),
			h.OnKeyDownPreventDefault((key) =>
				key === "Escape"
					? Option.some(Message.PressedToastEscape({ toastId: toast.id }))
					: Option.none(),
			),
		],
		[
			h.div(
				[
					h.Class(toastContentStyles),
					...(placement.visibleIndex > 0 ? [h.DataAttribute("behind", "")] : []),
					...(isExpandedNow ? [h.DataAttribute("expanded", "")] : []),
				],
				[
					h.div(
						[h.Class(toastBodyStyles)],
						[
							...toastIcon(h, toast.type),
							h.div(
								[h.Class(toastTextStyles)],
								[
									h.h2(
										[
											h.Class(toastTitleStyles),
											h.DataAttribute("slot", "toast-title"),
											...typeAttribute(h, toast.type),
											h.Id(titleId(toast.id)),
										],
										[toast.title],
									),
									...(toast.description === ""
										? []
										: [
												h.p(
													[
														h.Class(toastDescriptionStyles),
														h.DataAttribute("slot", "toast-description"),
														...typeAttribute(h, toast.type),
														h.Id(descriptionId(toast.id)),
													],
													[toast.description],
												),
											]),
								],
							),
						],
					),
					...(toast.actionLabel === null
						? []
						: [
								h.button(
									[
										h.Class(buttonVariants({ size: "xs" })),
										h.DataAttribute("slot", "toast-action"),
										h.Tabindex(0),
										h.Type("button"),
										h.OnClick(Message.ClickedToastAction({ toastId: toast.id })),
									],
									[toast.actionLabel],
								),
							]),
				],
			),
		],
	)
}

/** `Toast.Portal` + `Toast.Viewport`: the bottom-right "Notifications" region and its toasts. */
export const region = Submodel.defineView<Model, Message>((model, h) => {
	const frontmost = Option.flatMapNullishOr(Array.head(model.toasts), (toast) => toast.height)
	return h.div(
		[
			h.DataAttribute("base-ui-portal", ""),
			h.DataAttribute("slot", "toast-portal"),
			h.Id(`${model.id}-portal`),
			h.OnMount(PortalToasts()),
		],
		[
			h.div(
				[
					...regionAttributes(h),
					h.Class(cn(...toastViewportStyles)),
					h.DataAttribute("position", POSITION),
					h.DataAttribute("slot", "toast-viewport"),
					h.Role("region"),
					...Option.toArray(
						Option.map(frontmost, (height) =>
							h.Style({ "--toast-frontmost-height": `${height}px` }),
						),
					),
					h.Tabindex(-1),
					h.OnMouseEnter(Message.EnteredViewport()),
					h.OnMouseLeave(Message.LeftViewport()),
					h.OnFocusEnter(Message.FocusedViewport()),
					h.OnFocusLeave(Message.BlurredViewport()),
				],
				Array.zipWith(model.toasts, placements(model.toasts), (toast, placement) =>
					toastRoot(h, model, toast, placement),
				),
			),
		],
	)
})

/** `AnchoredToasts`: the region for toasts pinned to an element (none are anchored yet). */
export const anchoredRegion = Submodel.defineView<Model, Message>((model, h) =>
	h.div(
		[
			h.DataAttribute("base-ui-portal", ""),
			h.DataAttribute("slot", "toast-portal-anchored"),
			h.Id(`${model.id}-portal-anchored`),
			h.OnMount(PortalToasts()),
		],
		[
			h.div([
				...regionAttributes(h),
				h.Class(toastViewportAnchoredStyles),
				h.DataAttribute("slot", "toast-viewport-anchored"),
				h.Role("region"),
				h.Tabindex(-1),
			]),
		],
	),
)

/** Both regions, in order, for a root view (the app shell or a lab page). */
export const regions = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	model: Model,
	toParentMessage: (message: Message) => ParentMessage,
): ReadonlyArray<Html> => [
	h.submodel({ slotId: "toasts-anchored", model, view: anchoredRegion, toParentMessage }),
	h.submodel({ slotId: "toasts", model, view: region, toParentMessage }),
]
