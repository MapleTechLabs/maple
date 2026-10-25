/**
 * The recessed track a connected group draws around its segments.
 *
 * `bg-black/…` rather than a surface token on purpose: a segmented control sits
 * on cards, toolbars, and dialogs of different shades, and a fixed surface color
 * reads as raised on the darker ones. Darkening whatever is behind it keeps the
 * track recessed everywhere.
 */
export const toggleGroupTrackStyles =
	"w-fit items-center gap-0.5 rounded-lg border border-input bg-black/[0.04] p-0.5 dark:bg-black/25"

export const toggleGroupStyles = "flex *:focus-visible:z-10"

export const toggleGroupHorizontalStyles = "*:pointer-coarse:after:min-w-auto"

export const toggleGroupVerticalStyles = "*:pointer-coarse:after:min-h-auto"

export const toggleGroupVerticalFlexStyles = "flex-col"

export const toggleGroupConnectedStyles = "w-fit gap-0.5"

export const toggleGroupStandaloneStyles = "flex-wrap gap-2"
