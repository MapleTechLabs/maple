/**
 * The layout the control needs in every mode. Deliberately *not* gated on
 * `unstyled`: `w-full` is what gives the field a definite width to lay out
 * against, and `field-sizing-content` on the inner textarea resolves against it.
 * Dropping it along with the chrome left an unstyled field shrink-to-fit, so an
 * empty one sized itself to a one-character-per-line placeholder and shot up to
 * its max height. Inside an `InputGroup` this span is `display: contents`, so
 * these classes are inert there either way.
 */
export const textareaControlLayoutStyles = "relative inline-flex w-full"

/** Border, background, shadow and focus ring — the part `unstyled` removes. */
export const textareaControlChromeStyles =
	"rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-raised ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-lg-inset has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive-a2 has-aria-invalid:border-destructive-a4 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-control sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive-a3"

export const textareaStyles =
	"field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5"

export const textareaSmStyles =
	"min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5"

export const textareaLgStyles = "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5"
