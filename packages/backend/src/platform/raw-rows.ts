/**
 * Rows from a raw `db.execute(sql`…`)`.
 *
 * Under the Effect drivers drizzle hands back the driver's own result object
 * (`{ rows, … }` from node-postgres and PGlite alike) although it declares a
 * row array. Normalize both shapes instead of trusting the declared type.
 */
export const rawRows = <Row>(
	result: ReadonlyArray<Row> | { readonly rows: ReadonlyArray<Row> },
): ReadonlyArray<Row> => ("rows" in result ? result.rows : result)
