import Foundation
import Testing

@testable import MapleAPI

/// The phone must show the number the web board shows for the same widget, so
/// these mirror the web's `toReadyData` cases.
struct WidgetDataTests {
	private func json(_ text: String) throws -> JSONValue {
		try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
	}

	@Test func untransformedEnvelopeUnwrapsToRows() throws {
		let data = WidgetData(response: try json(#"{"data":[{"bucket":"b1","api":3},{"bucket":"b2","api":5}]}"#), transform: nil)
		#expect(data.rows.count == 2)
		#expect(data.rows[1]["api"]?.number == 5)
	}

	@Test func reduceSumsTheNamedField() throws {
		var transform = WidgetTransform()
		transform.reduceField = "api"
		transform.reduceAggregate = "sum"
		let data = WidgetData(response: try json(#"{"data":[{"bucket":"b1","api":3},{"bucket":"b2","api":5}]}"#), transform: transform)
		#expect(data.number == 8)
	}

	@Test func reduceFallsBackToTheFirstNumericColumnWhenTheFieldIsMissing() throws {
		var transform = WidgetTransform()
		transform.reduceField = "missing"
		transform.reduceAggregate = "max"
		let data = WidgetData(response: try json(#"{"data":[{"bucket":"b1","p95":120},{"bucket":"b2","p95":340}]}"#), transform: transform)
		#expect(data.number == 340)
	}

	@Test func reduceOfNoRowsIsZero() throws {
		var transform = WidgetTransform()
		transform.reduceField = "value"
		let data = WidgetData(response: try json(#"{"data":[]}"#), transform: transform)
		#expect(data.number == 0)
	}

	@Test func singleObjectPayloadReducesLikeOneRow() throws {
		var transform = WidgetTransform()
		transform.reduceField = "errorRate"
		let data = WidgetData(response: try json(#"{"data":{"errorRate":0.042,"totalErrors":12}}"#), transform: transform)
		#expect(data.number == 0.042)
	}

	@Test func sortAndLimitKeepTheTopRows() throws {
		var transform = WidgetTransform()
		transform.sortField = "value"
		transform.sortDescending = true
		transform.limit = 2
		let data = WidgetData(
			response: try json(#"{"data":[{"name":"a","value":1},{"name":"b","value":9},{"name":"c","value":4}]}"#),
			transform: transform
		)
		#expect(data.rows.map { $0["name"]?.string } == ["b", "c"])
	}

	@Test func ratioDividesNumeratorByDenominators() throws {
		var transform = WidgetTransform()
		transform.ratio = ("errors", ["ok", "errors"])
		let data = WidgetData(
			response: try json(#"{"data":[{"name":"errors","value":5},{"name":"ok","value":15}]}"#),
			transform: transform
		)
		#expect(data.number == 0.25)
	}

	@Test func hiddenSeriesAreDroppedButBucketStays() throws {
		var transform = WidgetTransform()
		transform.hiddenSeries = ["A"]
		let data = WidgetData(
			response: try json(#"{"data":[{"bucket":"b1","A":1,"A (prev)":2,"B":3}]}"#),
			transform: transform
		)
		#expect(Set(data.rows[0].keys) == ["bucket", "B"])
	}

	@Test func outcomePayloadKeepsNumbersAndBooleansApart() throws {
		let json = #"{"widget_id":"w","ok":true,"data":{"data":[{"one":1,"zero":0,"flag":true,"half":0.5,"name":"a","none":null}]}}"#
		let outcome = try JSONDecoder().decode(Components.Schemas.DashboardWidgetDataOutcome.self, from: Data(json.utf8))
		let row = try #require(WidgetOutcome(outcome).response?["data"]?.array?.first?.object)
		#expect(row["one"] == .number(1))
		#expect(row["zero"] == .number(0))
		#expect(row["flag"] == .bool(true))
		#expect(row["half"] == .number(0.5))
		#expect(row["name"] == .string("a"))
		#expect(row["none"] == .null)
	}

	@Test func untransformedStatPicksTheSameColumnEveryTime() throws {
		let data = WidgetData(response: try json(#"{"data":[{"bucket":"b1","zeta":9,"alpha":2,"mid":5}]}"#), transform: nil)
		#expect(data.number == 2)
	}
}
