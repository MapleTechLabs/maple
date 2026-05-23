/**
 * Defines typed table descriptors for the browser IndexedDB integration.
 *
 * An `IndexedDbTable` records the object store name, row schema, primary key
 * path, indexes, auto-increment behavior, and transaction durability used by
 * database versions, migrations, and typed queries. These descriptors are
 * useful for local caches, offline-first application state, background queues,
 * drafts, and other browser-persisted data that should be validated through
 * `Schema`.
 *
 * Key paths and index paths must reference encoded schema fields whose values
 * are valid IndexedDB keys, and compound paths are represented as readonly
 * arrays. Tables without a key path use an out-of-line `key` that is added to
 * reads and required for writes, so the row schema itself cannot define a
 * `key` field. Auto-increment tables require a numeric key path; when that key
 * is omitted on write, the module uses a derived schema without the generated
 * key. Declaring indexes here types query builder index selection, but the
 * indexes still need to be created during database migrations.
 *
 * @since 4.0.0
 */
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"
import type { NoInfer } from "effect/Types"
import * as IndexedDb from "./IndexedDb.ts"
import type * as IndexedDbQueryBuilder from "./IndexedDbQueryBuilder.ts"

const TypeId = "~@effect/platform-browser/IndexedDbTable"

/**
 * Typed IndexedDB table definition containing its name, schema, key path, indexes, auto-increment setting, and transaction durability.
 *
 * @category interface
 * @since 4.0.0
 */
export interface IndexedDbTable<
  out Name extends string,
  out TableSchema extends AnySchemaStruct,
  out Indexes extends Record<
    string,
    IndexedDbQueryBuilder.KeyPath<TableSchema>
  >,
  out KeyPath extends Readonly<IDBValidKey | undefined>,
  out AutoIncrement extends boolean
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly tableName: Name
  readonly tableSchema: TableSchema
  readonly readSchema: Schema.Top
  readonly autoincrementSchema: Schema.Top
  readonly arraySchema: Schema.Top
  readonly keyPath: KeyPath
  readonly indexes: Indexes
  readonly autoIncrement: AutoIncrement
  readonly durability: IDBTransactionDurability
}

/**
 * Schema constraint for table schemas that expose struct fields.
 *
 * @category models
 * @since 4.0.0
 */
export type AnySchemaStruct = Schema.Top & {
  readonly fields: Schema.Struct.Fields
}

/**
 * Type-erased shape of an `IndexedDbTable` used when table type parameters are not needed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly keyPath: any
  readonly tableName: string
  readonly tableSchema: Schema.Top
  readonly readSchema: Schema.Top
  readonly autoincrementSchema: Schema.Top
  readonly arraySchema: Schema.Top
  readonly autoIncrement: boolean
  readonly indexes: any
}

/**
 * Type-erased `IndexedDbTable` retaining the table interface properties with broad type parameters.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyWithProps = IndexedDbTable<
  string,
  AnySchemaStruct,
  any,
  any,
  boolean
>

/**
 * Extracts the table name type from an `IndexedDbTable`.
 *
 * @category models
 * @since 4.0.0
 */
export type TableName<Table extends Any> = Table["tableName"]
/**
 * Extracts the key-path type from an `IndexedDbTable`.
 *
 * @category models
 * @since 4.0.0
 */
export type KeyPath<Table extends Any> = Table["keyPath"]

/**
 * Extracts the auto-increment flag type from an `IndexedDbTable`.
 *
 * @category models
 * @since 4.0.0
 */
export type AutoIncrement<Table extends Any> = Table["autoIncrement"]

/**
 * Extracts the schema type from an `IndexedDbTable`.
 *
 * @category models
 * @since 4.0.0
 */
export type TableSchema<Table extends Any> = Table["tableSchema"]
/**
 * Extracts the decoding or encoding service requirements needed by an `IndexedDbTable` schema.
 *
 * @category models
 * @since 4.0.0
 */
export type Context<Table extends Any> =
  | Table["tableSchema"]["DecodingServices"]
  | Table["tableSchema"]["EncodingServices"]

/**
 * Extracts the encoded row type from an `IndexedDbTable` schema.
 *
 * @category models
 * @since 4.0.0
 */
export type Encoded<Table extends Any> = Table["tableSchema"]["Encoded"]

/**
 * Extracts the index definition map from an `IndexedDbTable`.
 *
 * @category models
 * @since 4.0.0
 */
export type Indexes<Table extends Any> = Table["indexes"]

/**
 * Selects the table with the given name from a union of `IndexedDbTable` types.
 *
 * @category models
 * @since 4.0.0
 */
export type WithName<Table extends Any, TableName extends string> = Extract<
  Table,
  { readonly tableName: TableName }
>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Creates a typed IndexedDB table definition from its name, schema, optional key path, indexes, auto-increment flag, and durability.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  const Name extends string,
  TableSchema extends AnySchemaStruct,
  const Indexes extends Record<
    string,
    IndexedDbQueryBuilder.KeyPath<TableSchema>
  >,
  const KeyPath extends
    | (AutoIncrement extends true ? IndexedDbQueryBuilder.KeyPathNumber<NoInfer<TableSchema>>
      : IndexedDbQueryBuilder.KeyPath<NoInfer<TableSchema>>)
    | undefined = undefined,
  const AutoIncrement extends boolean = false
>(options: {
  readonly name: Name
  readonly schema: [KeyPath] extends [undefined]
    ? "key" extends keyof TableSchema["fields"] ? "Cannot have a 'key' field when keyPath is undefined"
    : TableSchema
    : TableSchema
  readonly keyPath?: KeyPath
  readonly indexes?: Indexes | undefined
  readonly autoIncrement?: IsValidAutoIncrementKeyPath<
    TableSchema,
    KeyPath
  > extends true ? AutoIncrement | undefined
    : never
  readonly durability?: IDBTransactionDurability | undefined
}): IndexedDbTable<
  Name,
  TableSchema,
  Indexes,
  Extract<KeyPath, Readonly<IDBValidKey | undefined>>,
  AutoIncrement
> => {
  // oxlint-disable-next-line typescript/no-extraneous-class
  class Table {}
  Object.assign(Table, Proto)
  const readSchema = options.keyPath === undefined
    ? Schema.Struct({
      ...(options.schema as Schema.Struct<{}>).fields,
      key: IndexedDb.IDBValidKey
    })
    : options.schema
  ;(Table as any).tableName = options.name
  ;(Table as any).tableSchema = options.schema
  ;(Table as any).readSchema = readSchema
  ;(Table as any).arraySchema = Schema.Array(readSchema as any)
  ;(Table as any).autoincrementSchema = options.autoIncrement
    ? Schema.Struct(Struct.omit((options.schema as Schema.Struct<{}>).fields, [options.keyPath!] as any))
    : options.schema
  ;(Table as any).keyPath = options.keyPath
  ;(Table as any).indexes = options.indexes
  ;(Table as any).autoIncrement = options.autoIncrement === true
  ;(Table as any).durability = options.durability ?? "relaxed"
  return Table as any
}

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

type IsValidAutoIncrementKeyPath<
  TableSchema extends AnySchemaStruct,
  KeyPath
> = KeyPath extends keyof TableSchema["Encoded"] ? TableSchema["Encoded"][KeyPath] extends number ? true
  : false
  : false
