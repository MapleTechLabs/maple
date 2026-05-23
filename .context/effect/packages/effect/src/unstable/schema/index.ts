/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for defining schema-backed domain models that need different shapes
 * for database access and JSON APIs.
 *
 * A model defined with this module keeps one field declaration as the source of
 * truth and derives the `select`, `insert`, `update`, `json`, `jsonCreate`, and
 * `jsonUpdate` variants from it. This is useful for persistence models whose
 * database representation differs from the public API, for example generated
 * columns, application-generated identifiers, sensitive fields that must not be
 * serialized to JSON, nullable database columns exposed as `Option`, SQLite
 * booleans, JSON stored as text, date-time audit columns, and generated UUIDs.
 *
 * Each variant is a schema in its own right, so choose the variant that matches
 * the boundary you are validating or encoding. Plain schemas are included in all
 * variants, while `Field` helpers opt a property into only the variants they
 * declare. Overrideable defaults such as timestamp helpers can still be provided
 * explicitly with `Override`, and JSON variants may differ from database variants
 * in both optionality and encoded representation.
 *
 * @since 4.0.0
 */
export * as Model from "./Model.ts"

/**
 * Build families of related struct schemas from one field definition.
 *
 * `VariantSchema` is useful when the same domain object needs several schema
 * views, such as database select / insert / update shapes, JSON read / write
 * shapes, public versus private API views, or constructor schemas with
 * generated defaults. {@link make} fixes a closed set of variant names and a
 * default variant, then returns helpers for defining shared `Struct` values,
 * per-variant `Field` values, schema classes, unions, and extracted
 * `Schema.Struct` projections.
 *
 * A plain schema in a variant struct is present in every variant, a `Field`
 * contributes a property only to the variants named in its config, and nested
 * variant structs are extracted recursively. Variants are projections, not
 * discriminated alternatives: this module does not add a tag field, so include
 * an explicit literal tag when a decoded union needs runtime discrimination.
 * Also remember that the default variant is the schema used by generated
 * classes and ordinary variant unions; per-variant schemas are exposed
 * separately on those generated values.
 *
 * @since 4.0.0
 */
export * as VariantSchema from "./VariantSchema.ts"
