import { Array as Arr, Order } from "effect"
import { describe, expect, it } from "vitest"
import {
	SECURITY_AUDIT_MODELS,
	securityAuditPriceLevel,
	type SecurityAuditModelOption,
} from "./security-audit"

const priced = (inputUsd: number, outputUsd: number) => ({ inputUsd, outputUsd })

describe("securityAuditPriceLevel", () => {
	it("never rates a cheaper model above a dearer one", () => {
		const byBlendedPrice = Order.mapInput(
			Order.Number,
			(model: SecurityAuditModelOption) => 3 * model.inputUsd + model.outputUsd,
		)
		const levels = Arr.map(Arr.sort(SECURITY_AUDIT_MODELS, byBlendedPrice), securityAuditPriceLevel)
		expect(levels).toEqual(Arr.sort(levels, Order.Number))
	})

	it("spans 1 for sub-dollar models to 5 for the dearest frontier tier", () => {
		expect(securityAuditPriceLevel(priced(0.1, 0.5))).toBe(1)
		expect(securityAuditPriceLevel(priced(2, 10))).toBe(3)
		expect(securityAuditPriceLevel(priced(4, 20))).toBe(4)
		expect(securityAuditPriceLevel(priced(15, 75))).toBe(5)
	})

	it("weighs input above output, since audit agents mostly read", () => {
		expect(securityAuditPriceLevel(priced(1, 0.1))).toBeGreaterThan(
			securityAuditPriceLevel(priced(0.1, 1)),
		)
	})
})
