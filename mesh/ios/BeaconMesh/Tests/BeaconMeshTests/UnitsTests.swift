@testable import BeaconMesh
import Foundation
import Testing

private let en = Locale(identifier: "en_US_POSIX")

@Suite struct UnitPreferenceTests {
    @Test func automaticFollowsTheRegion() {
        #expect(UnitPreference.automatic.resolve(locale: .metric) == .metric)
        #expect(UnitPreference.automatic.resolve(locale: .us) == .imperial)
        #expect(UnitPreference.automatic.resolve(locale: .uk) == .imperial)
    }

    @Test func explicitChoiceWinsOverTheRegion() {
        #expect(UnitPreference.metric.resolve(locale: .us) == .metric)
        #expect(UnitPreference.imperial.resolve(locale: .metric) == .imperial)
    }

    @Test func storageKeyAndRawValuesAreStable() {
        #expect(UnitPreference.storageKey == "beacon.units")
        #expect(UnitPreference(rawValue: "automatic") == .automatic)
        #expect(UnitPreference(rawValue: "bogus") == nil)
    }
}

@Suite struct UnitsDistanceTests {
    @Test func metricWholeMetresThenKilometres() {
        #expect(Units.distance(meters: 5, system: .metric, locale: en) == "5 m")
        #expect(Units.distance(meters: 999.4, system: .metric, locale: en) == "999 m")
        // 999.6 rounds to 1000 m, so it reads as kilometres instead of "1000 m"
        #expect(Units.distance(meters: 999.6, system: .metric, locale: en) == "1.0 km")
        #expect(Units.distance(meters: 1234, system: .metric, locale: en) == "1.2 km")
        #expect(Units.distance(meters: -3, system: .metric, locale: en) == "0 m")
    }

    @Test func imperialFeetUnder528ThenMiles() {
        #expect(Units.distance(meters: 5, system: .imperial, locale: en) == "16 ft")
        #expect(Units.distance(meters: 160, system: .imperial, locale: en) == "525 ft")
        #expect(Units.distance(meters: 161, system: .imperial, locale: en) == "0.1 mi")
        #expect(Units.distance(meters: 1000, system: .imperial, locale: en) == "0.6 mi")
    }

    @Test func accuracyUsesTheSameRules() {
        #expect(Units.accuracy(meters: 5, system: .metric, locale: en) == "5 m")
        #expect(Units.accuracy(meters: 5, system: .imperial, locale: en) == "16 ft")
    }

    @Test func spokenFormsForVoiceOver() {
        #expect(Units.distance(meters: 5, system: .metric, spoken: true, locale: en) == "5 meters")
        #expect(Units.distance(meters: 1, system: .metric, spoken: true, locale: en) == "1 meter")
        #expect(Units.distance(meters: 1234, system: .metric, spoken: true, locale: en) == "1.2 kilometers")
        #expect(Units.distance(meters: 5, system: .imperial, spoken: true, locale: en) == "16 feet")
        #expect(Units.distance(meters: 1000, system: .imperial, spoken: true, locale: en) == "0.6 miles")
    }

    @Test func numbersFollowTheLocale() {
        let german = Locale(identifier: "de_DE")
        #expect(Units.distance(meters: 1234, system: .metric, locale: german) == "1,2 km")
    }

    @Test func nonFiniteOrNegativeInputDoesNotCrash() {
        #expect(Units.distance(meters: .nan, system: .metric, locale: en) == "0 m")
        #expect(Units.distance(meters: .infinity, system: .imperial, locale: en) == "0 ft")
    }
}

@Suite struct UnitsHeightTests {
    @Test func displayInBothSystems() {
        #expect(Units.height(cm: 170, system: .metric, locale: en) == "170 cm")
        #expect(Units.height(cm: 170, system: .imperial, locale: en) == "5 ft 7 in")
        #expect(Units.height(cm: 30, system: .imperial, locale: en) == "1 ft 0 in")
        #expect(Units.height(cm: 260, system: .imperial, locale: en) == "8 ft 6 in")
    }

    @Test func spokenImperialForVoiceOver() {
        #expect(Units.height(cm: 170, system: .imperial, spoken: true, locale: en) == "5 feet 7 inches")
        #expect(Units.height(cm: 30, system: .imperial, spoken: true, locale: en) == "1 foot 0 inches")
        #expect(Units.height(cm: 175, system: .metric, spoken: true, locale: en) == "175 centimeters")
    }

    @Test func feetAndInchesAreNearestInch() {
        #expect(Units.feetAndInches(cm: 170) == (5, 7))
        #expect(Units.feetAndInches(cm: 30) == (1, 0))
        #expect(Units.feetAndInches(cm: 260) == (8, 6))
        #expect(Units.centimeters(feet: 5, inches: 7) == 170)
        #expect(Units.centimeters(feet: 1, inches: 0) == 30)
        #expect(Units.centimeters(feet: 8, inches: 6) == 259)
    }

    /// cm -> ft/in -> cm can only land on the inch grid, so it moves by at most half an inch. The value it lands on
    /// is then stable: converting again changes nothing.
    @Test func roundTripFromCentimetresStaysWithinHalfAnInchAndSettles() {
        for cm in ProfileLimits.heightRange {
            let (feet, inches) = Units.feetAndInches(cm: cm)
            let back = Units.centimeters(feet: feet, inches: inches)
            #expect(abs(back - cm) <= 1, "cm \(cm) came back as \(back)")
            let (f2, i2) = Units.feetAndInches(cm: back)
            #expect(Units.centimeters(feet: f2, inches: i2) == back, "cm \(cm) does not settle")
        }
    }

    @Test func imperialTextParsesBackToTheSameCentimetres() {
        for cm in ProfileLimits.heightRange {
            let (feet, inches) = Units.feetAndInches(cm: cm)
            let shown = Units.height(cm: cm, system: .imperial, locale: en)
            #expect(Units.parseHeight(shown) == Units.centimeters(feet: feet, inches: inches), "\(shown)")
        }
    }

    @Test func parseAcceptsTheCommonWays() {
        #expect(Units.parseHeight("170") == 170)
        #expect(Units.parseHeight("170 cm") == 170)
        #expect(Units.parseHeight("1.7 m") == 170)
        #expect(Units.parseHeight("5 ft 7 in") == 170)
        #expect(Units.parseHeight("5'7\"") == 170)
        #expect(Units.parseHeight("5'7") == 170)
        #expect(Units.parseHeight("5 7") == 170)
        #expect(Units.parseHeight("67 in") == 170)
        #expect(Units.parseHeight("5 ft") == 152)
        #expect(Units.parseHeight(" 5 FT 7 IN ") == 170)
    }

    @Test func parseRejectsWhatIsNotAHeightInRange() {
        #expect(Units.parseHeight("") == nil)
        #expect(Units.parseHeight("tall") == nil)
        #expect(Units.parseHeight("29 cm") == nil)
        #expect(Units.parseHeight("261") == nil)
        #expect(Units.parseHeight("9 ft") == nil)
        #expect(Units.parseHeight("5 ft 12 in") == nil)
        #expect(Units.parseHeight("5 furlongs") == nil)
        #expect(Units.parseHeight("1.2.3 m") == nil)
    }
}

@Suite struct ProfileDraftHeightTests {
    private func draft(cm: String) -> ProfileDraft {
        var d = ProfileDraft(); d.fullName = "A B"; d.heightCm = cm
        return d
    }

    @Test func switchingViewsShowsFeetAndInchesFromCentimetres() {
        var d = draft(cm: "170")
        d.setHeightSystem(.imperial)
        #expect(d.heightFeet == "5" && d.heightInches == "7")
        #expect(d.heightCm == "170")
    }

    @Test func switchingWithoutTypingNeverChangesTheStoredCentimetres() {
        for cm in ProfileLimits.heightRange {
            var d = draft(cm: String(cm))
            d.setHeightSystem(.imperial)
            d.setHeightSystem(.metric)
            #expect(d.heightCm == String(cm))
        }
    }

    @Test func typingInFeetAndInchesWritesCentimetres() {
        var d = draft(cm: "")
        d.setHeightSystem(.imperial)
        d.editHeightFeet("5")
        d.editHeightInches("7")
        #expect(d.heightCm == "170")
        d.setHeightSystem(.metric)
        #expect(d.heightCm == "170")
        #expect(d.validate(nowYear: 2026).isEmpty)
    }

    @Test func emptyFeetAndInchesClearTheHeight() {
        var d = draft(cm: "170")
        d.setHeightSystem(.imperial)
        d.editHeightFeet("")
        d.editHeightInches("")
        #expect(d.heightCm == "")
        #expect(d.validate(nowYear: 2026).isEmpty)
    }

    @Test func inchesAreOptionalAndFeetAloneMeansZeroInches() {
        var d = draft(cm: "")
        d.setHeightSystem(.imperial)
        d.editHeightFeet("6")
        #expect(d.heightCm == "183")
    }

    @Test func outOfRangeFeetAndInchesAreReportedAndNotSaved() {
        var d = draft(cm: "170")
        d.setHeightSystem(.imperial)
        d.editHeightFeet("9")
        #expect(d.validate(nowYear: 2026)["appearance.height_cm"] != nil)
        d.editHeightFeet("5"); d.editHeightInches("12")
        #expect(d.validate(nowYear: 2026)["appearance.height_cm"] != nil)
        d.editHeightInches("11"); d.editHeightFeet("8")
        // 8 ft 11 in is 272 cm, past the 260 cm limit
        #expect(d.validate(nowYear: 2026)["appearance.height_cm"] != nil)
        d.editHeightFeet("")
        #expect(d.validate(nowYear: 2026)["appearance.height_cm"] != nil)
    }

    @Test func everyCentimetreValueEditedInFeetAndInchesRoundTripsThroughTheForm() {
        for cm in ProfileLimits.heightRange {
            var d = draft(cm: "")
            d.setHeightSystem(.imperial)
            let (feet, inches) = Units.feetAndInches(cm: cm)
            d.editHeightFeet(String(feet))
            d.editHeightInches(String(inches))
            let stored = Int(d.heightCm)
            #expect(stored != nil && abs(stored! - cm) <= 1, "cm \(cm)")
            // back in the imperial view, the same pair is shown
            d.setHeightSystem(.metric)
            d.setHeightSystem(.imperial)
            #expect(d.heightFeet == String(feet) && d.heightInches == String(inches))
        }
    }

    @Test func metricStillValidatesAsBefore() {
        var d = draft(cm: "tall")
        #expect(d.validate(nowYear: 2026)["appearance.height_cm"] != nil)
        d.heightCm = "170"
        #expect(d.validate(nowYear: 2026).isEmpty)
    }
}
