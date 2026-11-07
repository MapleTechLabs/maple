import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"

import { type ApiKeyRow, rowToV2ApiKey, rowsToV2ApiKeys } from "./api-keys"

const keyRow: ApiKeyRow = {
	id: "0b5f4c2e-3a1d-4e8f-9c7b-1a2b3c4d5e6f",
	org_id: "org_1",
	name: "ci-pipeline",
	description: null,
	key_prefix: "maple_ak_9f2c",
	revoked: false,
	revoked_at: null,
	last_used_at: null,
	expires_at: null,
	scopes: ["dashboards:read"],
	kind: "standard",
	created_at: "2026-07-01T12:00:00.000Z",
	created_by: "user_1",
	created_by_email: "ci@acme.com",
}

describe("rowToV2ApiKey", () => {
	it("maps a synced row into the v2 model", () => {
		const key = Option.getOrThrow(rowToV2ApiKey(keyRow))
		assert.strictEqual(key.id, keyRow.id)
		assert.strictEqual(key.object, "api_key")
		assert.strictEqual(key.kind, "standard")
		assert.strictEqual(key.created_by, "user_1")
	})

	it("drops a key whose kind a newer server added, keeping the rest", () => {
		const future = { ...keyRow, id: "1c6f4c2e-3a1d-4e8f-9c7b-1a2b3c4d5e6f", kind: "service_account" }
		assert.isTrue(Option.isNone(rowToV2ApiKey(future)))
		assert.deepStrictEqual(
			Arr.map(rowsToV2ApiKeys([future, keyRow]), (key) => key.id),
			[keyRow.id],
		)
	})
})
