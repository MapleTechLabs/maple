export const messageScrollerStyles =
	"group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden"

export const messageScrollerViewportStyles =
	"size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent"

export const messageScrollerContentStyles = "flex h-max min-h-full flex-col gap-6"

export const messageScrollerItemStyles =
	"min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]"

export const messageScrollerButtonStyles =
	"absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180"

export const messageScrollerButtonIconStyles = "size-4"

export const messageScrollerButtonLabelStyles = "sr-only"
