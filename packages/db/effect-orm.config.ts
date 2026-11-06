import * as PgClient from "@effect/sql-pg/PgClient"
import { defineConfig } from "@maple-dev/effect-orm/kit"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import { Layer, Redacted } from "effect"

export default defineConfig({
	dialect: "postgres",
	schema: "./src/tables/index.ts",
	// drizzle-kit's folder layout: the deploy (alchemy) applies every `<ts>_<name>/migration.sql` here.
	out: "./drizzle",
	emit: "sql",
	// `status` and `verify` against a local database. Never point them at prd's primary.
	driver: Migrate.layerSqlClient().pipe(
		Layer.provide(
			PgClient.layer({
				url: Redacted.make(process.env.DATABASE_URL ?? "postgres://maple:maple@localhost:5499/maple"),
				maxConnections: 1,
			}),
		),
	),
})
