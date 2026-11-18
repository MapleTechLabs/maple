import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { hiddenEntryIssue } from "./hidden"

const HIDDEN = ["shop.payments"]
const issue = (sql: string, hidden: ReadonlyArray<string> = HIDDEN, database = "shop") =>
	hiddenEntryIssue(sql, hidden, database)

describe("hiddenEntryIssue", () => {
	it.each([
		["by its full name", "SELECT count() FROM shop.payments"],
		["by its table name alone", "SELECT count() FROM payments"],
		["in another case", "SELECT count() FROM Shop.PAYMENTS"],
		["in backticks", "SELECT count() FROM `shop`.`payments`"],
		["in double quotes", 'SELECT count() FROM "shop"."payments"'],
		["with space around the dot", "SELECT count() FROM shop . payments"],
		["with a comment inside the name", "SELECT count() FROM shop./* x */payments"],
		["right after the keyword", "SELECT count() FROM`payments`"],
		["in a join", "SELECT count() FROM shop.orders AS o JOIN shop.payments AS p ON o.id = p.order_id"],
		["in a subquery", "SELECT * FROM (SELECT amount FROM payments)"],
		["as a column qualifier", "SELECT payments.amount FROM shop.orders"],
		["in an IN set", "SELECT count() FROM shop.orders WHERE id IN shop.payments"],
	])("refuses a query naming a hidden table %s", (_how, sql) => {
		expect(issue(sql)).toContain("hid from agents")
	})

	it("says which name in the query matched, and how to mean something else by a bare one", () => {
		const bare = issue("SELECT count() FROM shop.orders AS payments")
		expect(bare).toContain("`payments` names a table")
		expect(bare).toContain("`alias.payments`")
		expect(issue("SELECT count() FROM shop.payments")).toContain("`shop.payments` names a table")
	})

	it.each([
		["a visible table", "SELECT count() FROM shop.orders WHERE $__timeFilter(created_at)"],
		["the same table name in another database", "SELECT count() FROM analytics.payments"],
		["the name inside a string", "SELECT count() FROM shop.orders WHERE kind = 'shop.payments'"],
		["the name inside a comment", "SELECT count() FROM shop.orders -- not shop.payments\n"],
		["a longer name that contains it", "SELECT count() FROM shop.payments_daily"],
		["a column of a visible table spelled like the database", "SELECT o.shop FROM shop.orders AS o"],
		["a qualified column spelled like the table", "SELECT o.payments FROM shop.orders AS o"],
	])("runs a query naming only %s", (_what, sql) => {
		expect(issue(sql)).toBeNull()
	})

	it("reads a bare name in the connection's own database only", () => {
		// `payments` here is `analytics.payments`, which nobody hid.
		expect(issue("SELECT count() FROM payments", HIDDEN, "analytics")).toBeNull()
		expect(issue("SELECT p.amount FROM payments AS p", HIDDEN, "analytics")).toBeNull()
		expect(issue("SELECT count() FROM shop.payments", HIDDEN, "analytics")).toContain("hid from agents")
		expect(issue("SELECT count() FROM payments", HIDDEN, "SHOP")).toContain("hid from agents")
	})

	it("never takes a function call for a hidden table of the same name", () => {
		const hidden = ["shop.count", "shop.sum"]
		expect(issue("SELECT count(), sum(total) FROM shop.orders", hidden)).toBeNull()
		expect(issue("SELECT count ( * ) FROM shop.orders", hidden)).toBeNull()
		expect(issue("SELECT * FROM count", hidden)).toContain("hid from agents")
		expect(issue("SELECT * FROM shop.count", hidden)).toContain("hid from agents")
	})

	it.each([
		["system.tables", "SELECT name FROM system.tables WHERE database = 'shop'"],
		["system.columns, quoted", "SELECT name FROM `system`.`columns`"],
		["system with a comment before the dot", "SELECT name FROM system/**/.tables"],
		["information_schema", "SELECT table_name FROM INFORMATION_SCHEMA.TABLES"],
		["information_schema in lower case", "SELECT table_name FROM information_schema.tables"],
	])("refuses a query reading %s", (_what, sql) => {
		expect(issue(sql)).toContain("those databases list them")
	})

	it("refuses every query when the connection's own database is the system one", () => {
		expect(issue("SELECT name FROM tables", HIDDEN, "system")).toContain("`system`")
	})

	it("still lets a column called system through", () => {
		expect(issue("SELECT system FROM shop.orders")).toBeNull()
		expect(issue("SELECT o.system FROM shop.orders AS o")).toBeNull()
	})

	it.each([
		["EXPLAIN", "SELECT * FROM (EXPLAIN SELECT * FROM shop.orders_view)"],
		["EXPLAIN", "SELECT * FROM ( /* plan */ explain indexes = 1 SELECT 1)"],
		["EXPLAIN", "WITH plan AS (EXPLAIN (SELECT * FROM shop.orders_view)) SELECT * FROM plan"],
		["DESCRIBE", "SELECT * FROM (DESCRIBE shop.orders_view)"],
		["DESC", "SELECT * FROM (DESC TABLE shop.orders_view)"],
		["SHOW", "SELECT * FROM (SHOW CREATE TABLE shop.orders_view)"],
	])("refuses %s in a subquery, which prints what a view reads", (keyword, sql) => {
		expect(issue(sql)).toContain(`\`${keyword}\` in a subquery`)
	})

	it("lets a column named like one of those statements through", () => {
		expect(issue("SELECT max(show), count(desc), (explain) FROM shop.orders")).toBeNull()
		expect(issue("SELECT `show` FROM shop.orders ORDER BY (id) DESC")).toBeNull()
	})

	it.each([
		["after a clause word used as an alias", "SELECT card FROM numbers(1) select, 'payments'"],
		["after a quoted clause word", "SELECT card FROM numbers(1) `limit`, 'payments'"],
		[
			"after a join condition naming a clause word",
			"SELECT card FROM orders AS a JOIN kw AS b ON a.id = b.id AND limit = 0, 'payments'",
		],
		["after SAMPLE and OFFSET", "SELECT card FROM s SAMPLE 1 OFFSET 0, 'payments'"],
		["spelled with a hex escape", "SELECT card FROM numbers(1) select, 'pay\\x6dents'"],
		["in another case", "SELECT card FROM numbers(1) select, 'PAYMENTS'"],
		[
			"with a doubled quote in a neighbour",
			"SELECT 'it''s' AS s, card FROM numbers(1) select, 'payments'",
		],
	])("refuses a string that spells a hidden table %s", (_where, sql) => {
		expect(issue(sql)).toContain("equals the name of a table an admin hid from agents")
	})

	it("refuses that string as a plain value too, and says it is the value that matches", () => {
		expect(issue("SELECT count() FROM orders WHERE name = 'payments'")).toContain(
			"even as a plain value in a filter",
		)
	})

	it.each([
		["a visible table's name", "SELECT count() FROM orders WHERE name = 'orders'"],
		[
			"a longer value that contains the hidden name",
			"SELECT count() FROM orders WHERE name = 'payments_2026'",
		],
		[
			"a LIKE pattern with escaped wildcards",
			"SELECT count() FROM orders WHERE name LIKE '100\\%\\_off'",
		],
		[
			"the hidden table's full name, which a string never resolves",
			"SELECT 'shop.payments' AS label FROM orders",
		],
	])("runs a query whose string is %s", (_what, sql) => {
		expect(issue(sql)).toBeNull()
	})

	it("reads a string against the connection's own database only", () => {
		expect(issue("SELECT card FROM numbers(1) select, 'payments'", HIDDEN, "analytics")).toBeNull()
	})

	it.each([
		["\\x without two hex digits", "SELECT count() FROM orders WHERE name = 'pay\\x6gents'"],
		[
			"a backslash before an unknown letter, read either way",
			"SELECT card FROM numbers(1) select, 'pay\\ments'",
		],
	])("refuses a string holding %s", (_what, sql) => {
		expect(issue(sql)).not.toBeNull()
	})

	it("leaves a backslash in a string literal alone", () => {
		expect(issue("SELECT count() FROM shop.orders WHERE note = 'a\\'b' AND kind = 'x\\\\y'")).toBeNull()
	})

	it.each([
		["dictget", "SELECT dictGet('shop.payments_dict', 'amount', toUInt64(1))"],
		["dictgetordefault", "SELECT dictGetOrDefault('d', 'a', toUInt64(1), 0) FROM shop.orders"],
		["joinget", "SELECT joinGet('shop.payments_join', 'amount', 1)"],
	])("refuses %s, which reads a table named by a string", (name, sql) => {
		expect(issue(sql)).toContain(`\`${name}\` reads a table or dictionary named by a string`)
	})

	it("matches a hidden table whose own name holds a dot", () => {
		const hidden = ["shop.audit.log"]
		expect(issue("SELECT * FROM shop.`audit.log`", hidden)).toContain("hid from agents")
		expect(issue("SELECT * FROM `audit.log`", hidden)).toContain("hid from agents")
		expect(issue("SELECT * FROM shop.audit", hidden)).toBeNull()
	})

	it("matches a hidden table named with digits or a dollar sign, written bare", () => {
		expect(issue("SELECT * FROM 2024_events", ["shop.2024_events"])).toContain("hid from agents")
		expect(issue("SELECT * FROM pay$x", ["shop.pay$x"])).toContain("hid from agents")
		expect(issue("SELECT * FROM shop.60", ["shop.60"])).toContain("hid from agents")
		expect(issue("SELECT 60 FROM shop.orders", ["shop.60"])).toBeNull()
	})

	it("gives the same verdicts on a long query against a catalog with thousands of hidden tables", () => {
		const hidden = Arr.makeBy(2_000, (i) => `shop.hidden_${i}`)
		const visible = Arr.join(
			Arr.makeBy(1_500, (i) => `SELECT a.b.c_${i}, o.id FROM shop.orders AS o`),
			" UNION ALL ",
		)
		expect(visible.length).toBeGreaterThan(30_000)
		expect(issue(visible, hidden)).toBeNull()
		expect(issue(`${visible} UNION ALL SELECT 1, id FROM hidden_1999`, hidden)).toContain(
			"`hidden_1999` names a table",
		)
		expect(issue(`${visible} UNION ALL SELECT 1, id FROM x.shop.hidden_7`, hidden)).toContain(
			"`shop.hidden_7` names a table",
		)
	})

	it("checks nothing on a source with no hidden entries", () => {
		expect(issue("SELECT name FROM system.tables", [])).toBeNull()
		expect(issue("SELECT * FROM (EXPLAIN SELECT 1)", [])).toBeNull()
	})
})
