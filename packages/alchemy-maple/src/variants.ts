// Explicitly exclude other variants' fields: Input wraps the discriminant too,
// so TypeScript's usual excess-property check alone cannot keep them separate.
type VariantKeys<T> = T extends unknown ? keyof T : never

/** Each member of `T`, refusing the fields that only other members declare. */
export type ExclusiveVariant<T, All = T> = T extends unknown
	? T & Partial<Record<Exclude<VariantKeys<All>, keyof T>, never>>
	: never
