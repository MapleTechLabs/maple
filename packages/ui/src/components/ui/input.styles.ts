/**
 * Layout the control needs in every mode — see the note on `Textarea`'s
 * `textareaControlLayoutStyles`. Not gated on `unstyled`: without `w-full` the field is
 * shrink-to-fit, which is never what a form row wants.
 */
export const inputControlLayoutStyles = "relative inline-flex w-full"

/** Border, background, shadow and focus ring — the part `unstyled` removes. */
export const inputControlChromeStyles =
	"rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]"

export const inputStyles =
	"h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] placeholder:text-foreground-subtle sm:h-7.5 sm:leading-7.5"

export const inputSmStyles = "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5"

export const inputLgStyles = "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5"

export const inputSearchStyles =
	"[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none"

export const inputFileStyles =
	"text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm"
