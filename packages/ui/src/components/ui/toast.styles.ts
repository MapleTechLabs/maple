export function upsertReplayClassName(toast: { type?: string; updateKey?: number }): string | undefined {
	const k = toast.updateKey ?? 0
	if (k <= 0) return undefined
	const isEven = k % 2 === 0
	if (toast.type === "error") {
		return isEven ? "animate-toast-error-even" : "animate-toast-error-odd"
	}
	return isEven ? "animate-toast-success-even" : "animate-toast-success-odd"
}

export const toastViewportStyles = [
	"fixed z-60 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
	"data-[position*=top]:top-(--toast-inset)",
	"data-[position*=bottom]:bottom-(--toast-inset)",
	"data-[position*=left]:left-(--toast-inset)",
	"data-[position*=right]:right-(--toast-inset)",
	"data-[position*=center]:left-1/2 data-[position*=center]:-translate-x-1/2",
] as const

export const toastRootStyles = [
	"absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none rounded-lg border bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(1%*max(0,var(--toast-index,0))))] not-dark:bg-clip-padding text-popover-foreground shadow-popup [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s,background-color_.5s] before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset before:shadow-control data-expanded:bg-popover dark:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(6%*max(0,var(--toast-index,0))))] dark:data-expanded:bg-popover",
	"data-[position*=right]:right-0 data-[position*=right]:left-auto",
	"data-[position*=left]:right-auto data-[position*=left]:left-0",
	"data-[position*=center]:right-0 data-[position*=center]:left-0",
	"data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-[50%_calc(50%-50%*min(var(--toast-index,0),1))]",
	"data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-[50%_calc(50%+50%*min(var(--toast-index,0),1))]",
	"after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
	"data-[position*=top]:after:top-full",
	"data-[position*=bottom]:after:bottom-full",
	"[--toast-calc-height:var(--toast-frontmost-height,var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
	"data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
	"data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
	"data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
	"data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
	"data-limited:opacity-0",
	"data-expanded:h-(--toast-height)",
	"data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
	"data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
	"data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
	"data-ending-style:opacity-0",
	"data-[position*=top]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(-100%-var(--toast-inset)))]",
	"data-[position*=bottom]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
	"data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
	"data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
	"data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
	"data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
	"data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
	"data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
	"data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
	"data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
] as const

export const toastContentStyles =
	"pointer-events-auto flex items-center justify-between gap-1.5 overflow-hidden px-3.5 py-3 text-sm transition-opacity duration-250 data-behind:not-data-expanded:pointer-events-none data-behind:opacity-0 data-expanded:opacity-100"

export const toastBodyStyles = "flex gap-2"

export const toastAnchoredBodyStyles = "flex gap-2"

export const toastIconStyles = "[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const toastAnchoredIconStyles = "[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const toastIconGlyphStyles =
	"in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80"

export const toastAnchoredIconGlyphStyles =
	"in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80"

export const toastTextStyles = "flex flex-col gap-0.5"

export const toastAnchoredTextStyles = "flex flex-col gap-0.5"

export const toastTitleStyles = "font-medium"

export const toastAnchoredTitleStyles = "font-medium"

export const toastDescriptionStyles = "whitespace-pre-line text-muted-foreground"

export const toastAnchoredDescriptionStyles = "whitespace-pre-line text-muted-foreground"

export const toastViewportAnchoredStyles = "outline-none"

export const toastPositionerStyles = "z-50 max-w-[min(--spacing(64),var(--available-width))]"

export const toastPopupStyles =
	"relative text-balance border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:shadow-control data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"

export const toastPopupTooltipStyles = "rounded-md shadow-popup before:rounded-md-inset"

export const toastPopupDefaultStyles = "rounded-lg shadow-popup before:rounded-lg-inset"

export const toastPopupTooltipContentStyles = "pointer-events-auto px-2 py-1"

export const toastPopupContentStyles =
	"pointer-events-auto flex items-center justify-between gap-1.5 overflow-hidden px-3.5 py-3 text-sm"
