import Foundation
import Testing

@testable import MapleAPI

/// The server only returns buckets where a severity occurred; stacking by
/// array index would slide a sparse series to the left of the chart.
@Suite("Log volume")
struct LogVolumeTests {
	private let start = Date(timeIntervalSince1970: 1_800_000_000)

	private func at(_ bucket: Int) -> Date { start.addingTimeInterval(Double(bucket) * 60) }

	@Test("Sparse series land on their own buckets, zero elsewhere")
	func alignsSparseSeries() {
		let volume = LogVolume(
			points: [
				(severity: "ERROR", points: [(at(5), 2), (at(12), 3), (at(30), 1)]),
				(severity: "INFO", points: (0..<40).map { (at($0), 10) }),
			],
			start: start,
			end: at(40),
			bucketSeconds: 60
		)
		let error = volume.series[0].values
		#expect(volume.series.map(\.values.count) == [40, 40])
		#expect(error[5] == 2 && error[12] == 3 && error[30] == 1)
		#expect(error.reduce(0, +) == 6)
		#expect(volume.totals[12] == 13 && volume.totals[0] == 10)
	}

	@Test("An unaligned window start still maps interval-aligned buckets")
	func snapsToInterval() {
		let unaligned = start.addingTimeInterval(25)
		let volume = LogVolume(
			points: [(severity: "WARN", points: [(at(0), 4), (at(3), 1)])],
			start: unaligned,
			end: unaligned.addingTimeInterval(240),
			bucketSeconds: 60
		)
		#expect(volume.series[0].values == [4, 0, 0, 1, 0])
	}

	@Test("Points outside the window are dropped")
	func dropsOutOfWindow() {
		let volume = LogVolume(
			points: [(severity: "ERROR", points: [(at(-1), 9), (at(1), 1), (at(9), 9)])],
			start: start,
			end: at(3),
			bucketSeconds: 60
		)
		#expect(volume.series[0].values == [0, 1, 0])
	}
}
