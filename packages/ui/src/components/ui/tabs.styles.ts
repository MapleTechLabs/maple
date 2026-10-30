export const tabsStyles = "flex flex-col gap-2 data-[orientation=vertical]:flex-row"

export const tabsListStyles =
	"relative z-0 flex w-fit items-center justify-center gap-x-0.5 text-muted-foreground"

export const tabsListVerticalStyles = "data-[orientation=vertical]:flex-col"

export const tabsListDefaultStyles = "rounded-lg bg-muted p-0.5 text-foreground-subtle"

export const tabsListUnderlineStyles =
	"data-[orientation=vertical]:px-1 data-[orientation=horizontal]:py-1 *:data-[slot=tabs-tab]:hover:bg-accent"

export const tabsIndicatorStyles =
	"absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) transition-[width,translate] duration-200 ease-in-out"

export const tabsIndicatorUnderlineStyles =
	"z-10 bg-primary data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px data-[orientation=horizontal]:translate-y-px"

export const tabsIndicatorDefaultStyles = "-z-1 rounded-md bg-background shadow-sm/5 dark:bg-input"

export const tabsTabStyles =
	"relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] font-medium text-base outline-none transition-[color,background-color,box-shadow] hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:text-foreground data-disabled:opacity-64 sm:h-8 sm:text-sm [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0"

export const tabsPanelStyles = "flex-1 outline-none"
