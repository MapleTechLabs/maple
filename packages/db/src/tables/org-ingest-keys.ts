import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const OrgIngestKeys = PG.table("org_ingest_keys", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		publicKey: PG.column(PG.text, { name: "public_key" }),
		publicKeyHash: PG.column(PG.text, { name: "public_key_hash" }),
		privateKeyCiphertext: PG.column(PG.text, { name: "private_key_ciphertext" }),
		privateKeyIv: PG.column(PG.text, { name: "private_key_iv" }),
		privateKeyTag: PG.column(PG.text, { name: "private_key_tag" }),
		privateKeyHash: PG.column(PG.text, { name: "private_key_hash" }),
		publicRotatedAt: PG.column(PG.timestamptzMillis, { name: "public_rotated_at" }),
		privateRotatedAt: PG.column(PG.timestamptzMillis, { name: "private_rotated_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: { columns: ["orgId"], name: "org_ingest_keys_org_id_pk" },
	indexes: [
		PG.uniqueIndex("org_ingest_keys_public_key_unique", ["publicKey"]),
		PG.uniqueIndex("org_ingest_keys_public_key_hash_unique", ["publicKeyHash"]),
		PG.uniqueIndex("org_ingest_keys_private_key_hash_unique", ["privateKeyHash"]),
	],
	tenantColumn: "orgId",
})

export type OrgIngestKeyRow = PG.SelectRowOf<typeof OrgIngestKeys>
export type OrgIngestKeyInsert = PG.InsertRowOf<typeof OrgIngestKeys>
