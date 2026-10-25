export const skeletonListGapStyles = {
	"0": null,
	px: "gap-px",
	"1": "gap-1",
	"2": "gap-2",
	"3": "gap-3",
	"6": "gap-6",
} as const

// The sweep lives on a transform-animated pseudo-element so it stays on the
// compositor — animating background-position on a `fixed`-attachment gradient
// repaints every skeleton per frame and visibly lags busy loading screens.
export const skeletonStyles =
	"relative isolate overflow-hidden rounded-sm bg-muted before:absolute before:inset-0 before:animate-skeleton before:[background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] [--skeleton-highlight:--alpha(var(--color-white)/64%)] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)] motion-reduce:before:animate-none"

export const skeletonListRowDefaultStyles = "h-8"

export const skeletonListStyles = "flex flex-col"

export const skeletonListRowStyles = "w-full"
