// Class joining and variant lookup, the subset of clsx and class-variance-authority the kit uses.
// Emits classes in the same order: base, variants (declaration order), compound variants, className.

export type ClassValue = string | number | false | null | undefined | ReadonlyArray<ClassValue>

const classOf = (value: ClassValue): string =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : value ? cx(...value) : ""

/** Joins class values with single spaces, skipping falsy values and flattening arrays. */
export const cx = (...inputs: ReadonlyArray<ClassValue>): string =>
	inputs.reduce<string>((joined, input) => {
		const next = input ? classOf(input) : ""
		return next === "" ? joined : joined === "" ? next : `${joined} ${next}`
	}, "")

type VariantSchema = Record<string, Record<string, string>>

type VariantKey<Key> = Key extends "true" | "false" ? boolean : Key

type VariantSelection<S extends VariantSchema> = {
	readonly [Name in keyof S]?: VariantKey<keyof S[Name]> | null | undefined
}

type CompoundVariant<S extends VariantSchema> = {
	readonly [Name in keyof S]?: VariantKey<keyof S[Name]> | ReadonlyArray<VariantKey<keyof S[Name]>>
} & { readonly class: ClassValue }

export type VariantConfig<S extends VariantSchema> = {
	readonly variants: S
	readonly defaultVariants?: NoInfer<{ readonly [Name in keyof S]?: VariantKey<keyof S[Name]> }>
	readonly compoundVariants?: NoInfer<ReadonlyArray<CompoundVariant<S>>>
}

export type VariantOptions<S extends VariantSchema> = VariantSelection<S> & {
	readonly className?: ClassValue
}

/** The selection a `variants()` function accepts, without `className`. */
export type VariantProps<F> = F extends (options?: infer O) => string
	? Omit<NonNullable<O>, "className">
	: never

// Booleans and 0 select their string key; any other falsy selection falls back to the default.
const keyOf = (value: unknown): unknown =>
	typeof value === "boolean" ? `${value}` : value === 0 ? "0" : value

type Selection = Readonly<Record<string, unknown>>

const compoundMatches = (condition: Selection, selection: Selection): boolean =>
	Object.entries(condition).every(([name, expected]) =>
		Array.isArray(expected) ? expected.includes(selection[name]) : selection[name] === expected,
	)

const withoutUndefined = (options: Selection): Selection =>
	Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))

const classFor = (table: Readonly<Record<string, string>>, key: unknown): string | undefined => {
	if (key === undefined || key === null) return undefined
	const name = String(key)
	return Object.hasOwn(table, name) ? table[name] : undefined
}

/** Builds a class-name function from a base class, variant tables, defaults and compound variants. */
export const variants =
	<S extends VariantSchema = Record<never, never>>(base: ClassValue, config?: VariantConfig<S>) =>
	(options: VariantOptions<S> = {}): string => {
		const selection: Selection = options
		const defaults: Selection = config?.defaultVariants ?? {}
		const variantClasses = Object.entries(config?.variants ?? {}).map(([name, table]) =>
			selection[name] === null
				? null
				: classFor(table, keyOf(selection[name]) || keyOf(defaults[name])),
		)
		const resolved: Selection = { ...defaults, ...withoutUndefined(selection) }
		const compoundClasses = (config?.compoundVariants ?? []).map(({ class: className, ...condition }) =>
			compoundMatches(condition, resolved) ? className : null,
		)
		return cx(base, variantClasses, compoundClasses, options.className)
	}
