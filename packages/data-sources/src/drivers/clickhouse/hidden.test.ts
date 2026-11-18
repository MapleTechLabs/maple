import { describe, expect, it } from "vitest"
import { hasEscapedIdentifier, hiddenEntryIssue } from "./hidden"

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

	it("says which name in the query matched", () => {
		expect(issue("SELECT count() FROM shop.orders AS payments")).toContain("`payments`")
		expect(issue("SELECT count() FROM shop.payments")).toContain("`shop.payments`")
	})

	it.each([
		["a visible table", "SELECT count() FROM shop.orders WHERE $__timeFilter(created_at)"],
		["the same table name in another database", "SELECT count() FROM analytics.payments"],
		["the name inside a string", "SELECT count() FROM shop.orders WHERE kind = 'shop.payments'"],
		["the name inside a comment", "SELECT count() FROM shop.orders -- not shop.payments\n"],
		["a longer name that contains it", "SELECT count() FROM shop.payments_daily"],
		["a column of a visible table spelled like the database", "SELECT o.shop FROM shop.orders AS o"],
	])("runs a query naming only %s", (_what, sql) => {
		expect(issue(sql)).toBeNull()
	})

	it.each([
		["system.tables", "SELECT name FROM system.tables WHERE database = 'shop'"],
		["system.columns, quoted", "SELECT name FROM `system`.`columns`"],
		["system with a comment before the dot", "SELECT name FROM system/**/.tables"],
		["information_schema", "SELECT table_name FROM INFORMATION_SCHEMA.TABLES"],
		["information_schema in lower case", "SELECT table_name FROM information_schema.tables"],
	])("refuses a query reading %s", (_what, sql) => {
		expect(issue(sql)).toContain("lists them")
	})

	it("refuses every query when the connection's own database is the system one", () => {
		expect(issue("SELECT name FROM tables", HIDDEN, "system")).toContain("`system`")
	})

	it("still lets a column called system through", () => {
		expect(issue("SELECT system FROM shop.orders")).toBeNull()
		expect(issue("SELECT o.system FROM shop.orders AS o")).toBeNull()
	})

	it.each([
		["a hex escape in backticks", "SELECT count() FROM shop.`pay\\x6dents`"],
		["an escaped letter in double quotes", 'SELECT count() FROM shop."pay\\ments"'],
		["an escaped system database", "SELECT name FROM `sys\\x74em`.tables"],
	])("refuses a quoted identifier spelled with %s", (_how, sql) => {
		expect(issue(sql)).toContain("backslash")
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

	it("checks nothing on a source with no hidden entries", () => {
		expect(issue("SELECT name FROM system.tables", [])).toBeNull()
		expect(issue("SELECT count() FROM shop.`pay\\x6dents`", [])).toBeNull()
	})
})

describe("hasEscapedIdentifier", () => {
	it("finds a backslash in a quoted identifier and nowhere else", () => {
		expect(hasEscapedIdentifier("SELECT `e\\x6dail` FROM t")).toBe(true)
		expect(hasEscapedIdentifier('SELECT "e\\mail" FROM t')).toBe(true)
		expect(hasEscapedIdentifier("SELECT `email` FROM t WHERE a = 'x\\ny' -- \\\n")).toBe(false)
	})
})
