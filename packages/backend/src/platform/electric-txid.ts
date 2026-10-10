import * as PG from "@maple-dev/effect-orm/postgres"
import { PostgresTransactionId } from "@maple/domain"

/**
 * The transaction id of the statement it is returned from, cast to 32-bit `xid`
 * as Electric emits it and to text so every driver hands back a plain string:
 * `.returning(($) => ({ id: $.id, txid: currentTxid }))`. The TanStack DB
 * collection awaits that txid on the shape stream to settle its optimistic write.
 * Inside an explicit transaction it is that transaction's id, the one Electric sees.
 */
export const currentTxid = PG.sql(PG.text)`pg_current_xact_id()::xid::text`

/**
 * Reads the txid from a row returned with `currentTxid`. Returns `undefined`
 * when the row is missing so callers can degrade gracefully — the txid is an
 * optional response field; without it the client simply drops optimistic state
 * on the next synced update rather than on the precise transaction.
 */
export const readTxid = (
	rows: ReadonlyArray<{ readonly txid?: string | null }>,
): PostgresTransactionId | undefined => {
	const txid = rows[0]?.txid
	return txid == null ? undefined : PostgresTransactionId.make(txid)
}
