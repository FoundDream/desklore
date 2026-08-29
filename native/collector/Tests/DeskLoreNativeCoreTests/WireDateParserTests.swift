import DeskLoreNativeCore
import Foundation
import Testing

@Test("Visual capture expiry accepts JavaScript and standard ISO 8601 timestamps")
func visualCaptureExpiryFormats() {
    #expect(WireDateParser.parseISO8601("2026-08-22T07:12:48.123Z") != nil)
    #expect(WireDateParser.parseISO8601("2026-08-22T07:12:48Z") != nil)
    #expect(WireDateParser.parseISO8601("not-a-date") == nil)
}
