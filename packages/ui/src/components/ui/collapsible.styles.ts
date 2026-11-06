// `contain: layout paint` keeps each frame of the height transition from re-laying out
// the panel's descendants — the height is animated on the main thread, so this runs 12
// times per collapse. Never add `size` here: Base UI reads `scrollHeight` off this
// element to turn `auto` into the pixel value it animates from, and size containment
// would report 0.
export const collapsiblePanelStyles =
	"h-(--collapsible-panel-height) overflow-hidden [contain:layout_paint] transition-[height] duration-200 ease-out motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0"
