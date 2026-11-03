/**
 * Postgres built-in roles a login inherits instead of `postgres`, which owns every table. Both
 * cover tables created by later migrations, so no per-table grant or default privilege is needed.
 */
export const DB_ACCESS_ROLES = {
	/** SELECT on every table, view and sequence. */
	read: ["pg_read_all_data"],
	/** Plus INSERT, UPDATE, DELETE. No DDL, TRUNCATE, ownership or role management. */
	readWrite: ["pg_read_all_data", "pg_write_all_data"],
} as const

export type DbAccess = keyof typeof DB_ACCESS_ROLES
