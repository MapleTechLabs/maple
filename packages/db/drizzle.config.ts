import { defineConfig } from "drizzle-kit"

export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./drizzle",
	dialect: "postgresql",
	// Used by db:migrate/db:push/db:studio; db:generate never dials it.
	// CI passes the PlanetScale direct (5432) admin URL; the fallback is the
	// local docker-compose Postgres used by `alchemy dev`.
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://maple:maple@localhost:5499/maple",
	},
	// v1 manages every schema by default; Maple owns only `public` (the `drizzle`
	// migrations schema and Electric's publication objects must stay out of diffs).
	schemaFilter: ["public"],
})
