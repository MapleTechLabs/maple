export const cardStyles =
	"relative flex flex-col rounded-md border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const cardHeaderStyles =
	"grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 p-4 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-3 has-data-[slot=card-action]:grid-cols-[1fr_auto]"

export const cardTitleStyles = "font-semibold text-lg leading-none"

export const cardDescriptionStyles = "text-muted-foreground text-sm"

export const cardActionStyles = "col-start-2 row-span-2 row-start-1 inline-flex self-start justify-self-end"

export const cardPanelStyles =
	"flex-1 p-4 in-[[data-slot=card]:has(>[data-slot=card-header]:not(.border-b))]:pt-0 in-[[data-slot=card]:has(>[data-slot=card-footer]:not(.border-t))]:pb-0"

export const cardFooterStyles =
	"flex items-center p-4 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pt-3"
