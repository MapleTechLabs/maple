import { QueryEngineValidationError } from "@maple/domain/http"
import {
	WarehouseDecodeError,
	WarehouseInvalidInputError,
	WarehouseQueryError,
	WarehouseUnreachableError,
} from "@maple/web-data/warehouse/effect-utils"
import { describe, expect, test } from "vitest"
import { isTransientWidgetError } from "./widget-data"

const operation = "widget"

describe("which widget fetch failures are retried", () => {
	test("a dropped connection and a failed warehouse read are retried", () => {
		expect(isTransientWidgetError(new WarehouseUnreachableError({ operation, message: "offline" }))).toBe(
			true,
		)
		expect(isTransientWidgetError(new WarehouseQueryError({ operation, message: "502" }))).toBe(true)
	})

	test("a bad query, an unreadable answer and a too-wide range are not", () => {
		expect(isTransientWidgetError(new WarehouseInvalidInputError({ operation, message: "bad" }))).toBe(
			false,
		)
		expect(isTransientWidgetError(new WarehouseDecodeError({ operation, message: "shape" }))).toBe(false)
		expect(
			isTransientWidgetError(
				new QueryEngineValidationError({ message: "Time range too large", details: [] }),
			),
		).toBe(false)
	})
})
