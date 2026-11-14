import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { Array as Arr } from "effect"
import { encodeJson } from "../src/json"
import {
	LOCAL_SCHEMA_HISTORY_TIP,
	localSchemaHistory,
	localSchemaIdentity,
	localSchemaSnapshot,
} from "../src/local-schema-history"
import { CURRENT_LOCAL_SCHEMA, LEGACY_LOCAL_SCHEMA, LOCAL_SCHEMA_SQL } from "../src/schema-identity"
import { schemaDigest } from "../src/store-version"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("local schema history", () => {
	it("derives v0..v53 exactly as the literal entries that journals and markers already carry", () => {
		// The hash of the 54 hand-written entries this derivation replaced, including key order.
		expect(
			sha256(encodeJson(Arr.map(localSchemaHistory().slice(0, 54), (entry) => ({ ...entry })))),
		).toBe("83a483174119f6134ea4ec556395d027f3033be5795c7487942d35712eba5684")
	})

	it("ends at the current schema and starts at the legacy store", () => {
		expect(localSchemaHistory()).toHaveLength(LOCAL_SCHEMA_HISTORY_TIP + 1)
		expect(localSchemaIdentity(LOCAL_SCHEMA_HISTORY_TIP)).toEqual(CURRENT_LOCAL_SCHEMA)
		expect(schemaDigest(localSchemaSnapshot(LOCAL_SCHEMA_HISTORY_TIP).sql)).toBe(
			schemaDigest(LOCAL_SCHEMA_SQL),
		)
		expect(localSchemaIdentity(0)).toMatchObject({ ...LEGACY_LOCAL_SCHEMA, manifestDigest: "" })
	})

	it("refuses versions it has no snapshot for", () => {
		expect(() => localSchemaSnapshot(0)).toThrow(/no bundled DDL snapshot/)
		expect(() => localSchemaIdentity(LOCAL_SCHEMA_HISTORY_TIP + 1)).toThrow(/no entry for version/)
	})
})
