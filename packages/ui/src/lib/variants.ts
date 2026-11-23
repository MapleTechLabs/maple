// Class joining and variant lookup, the subset of clsx and class-variance-authority the kit uses.
// Emits classes in the same order: base, variants (declaration order), compound variants, className.
import * as Arr from "effect/Array"
import * as Rec from "effect/Record"

export type ClassValue = string | number | false | null | undefined | ReadonlyArray<ClassValue>

// Like clsx: empty strings, 0 and NaN contribute nothing.
const classOf = (value: ClassValue): string => {
	if (typeof value === "string") return value
	if (typeof value === "number") return value === 0 || Number.isNaN(value) ? "" : String(value)
	return value === false || value === null || value === undefined ? "" : cx(...value)
}

/** Joins class values with single spaces, skipping falsy values and flattening arrays. */
export const cx = (...inputs: ReadonlyArray<ClassValue>): string =>
	Arr.reduce(inputs, "", (joined, input) => {
		const next = classOf(input)
		return next === "" ? joined : joined === "" ? next : `${joined} ${next}`
	})

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

type Selection = Readonly<Record<string, unknown>>

// Booleans and numbers select their string key; an empty or missing selection takes the default.
const keyOf = (value: unknown): string => {
	if (typeof value === "string") return value
	if (typeof value === "boolean" || typeof value === "number") return `${value}`
	return ""
}

const classFor = (table: Readonly<Record<string, string>>, own: unknown, fallback: unknown) => {
	const key = keyOf(own) === "" ? keyOf(fallback) : keyOf(own)
	return Rec.has(table, key) ? table[key] : undefined
}

// Compound conditions compare against the defaults overlaid with every defined selection.
const compoundMatches = (condition: Selection, selection: Selection): boolean =>
	Arr.every(Rec.toEntries(condition), ([name, expected]) =>
		Arr.isArray(expected) ? Arr.contains(expected, selection[name]) : selection[name] === expected,
	)

/** Builds a class-name function from a base class, variant tables, defaults and compound variants. */
export const variants =
	<S extends VariantSchema = Record<never, never>>(base: ClassValue, config?: VariantConfig<S>) =>
	(options: VariantOptions<S> = {}): string => {
		const selection: Selection = options
		const defaults: Selection = config?.defaultVariants ?? {}
		const variantClasses = Arr.map(Rec.toEntries(config?.variants ?? {}), ([name, table]) =>
			selection[name] === null ? null : classFor(table, selection[name], defaults[name]),
		)
		const resolved = { ...defaults, ...Rec.filter(selection, (value) => value !== undefined) }
		const compoundClasses = Arr.map(
			config?.compoundVariants ?? [],
			({ class: className, ...condition }) => (compoundMatches(condition, resolved) ? className : null),
		)
		return cx(base, variantClasses, compoundClasses, options.className)
	}
