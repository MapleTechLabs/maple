// A grid, not a flex row: the head shrinks to one character and its ellipsis (2ch, never a sliver of a
// glyph) and the box never gets narrower than its tail.
export const middleTruncateStyles = "grid max-w-full grid-cols-[minmax(2ch,auto)_auto] justify-start"

export const middleTruncateMonoStyles = "font-mono"

export const middleTruncateHeadStyles = "truncate"

export const middleTruncateTailStyles = "shrink-0 whitespace-pre"
