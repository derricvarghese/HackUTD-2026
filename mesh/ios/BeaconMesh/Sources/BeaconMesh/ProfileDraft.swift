import Foundation

/// The profile form's state: every field is the text the user typed. Converts to/from `UserProfile` and validates
/// (including "not a number"), so the SwiftUI layer stays thin and this logic runs in Linux tests.
public struct ProfileDraft: Equatable {
    public struct PetDraft: Equatable, Identifiable {
        public var id = UUID()
        public var kind = ""
        public var count = ""
        public init(kind: String = "", count: String = "") { self.kind = kind; self.count = count }
    }

    public var fullName = ""
    public var preferredName = ""
    public var birthYear = ""
    /// Comma or line separated.
    public var languages = ""
    public var phone = ""
    /// Canonical height in centimetres (text). With the ft/in view, edits keep it in sync via `editHeightFeet/Inches`.
    public var heightCm = ""
    /// Which height view the form shows. Display only: `heightCm` is always the stored value.
    public var heightSystem: UnitSystem = .metric
    public var heightFeet = ""
    public var heightInches = ""
    /// True once the user typed into the ft/in fields; validation then checks those fields.
    public private(set) var heightEditedInImperial = false
    public var hair = ""
    public var clothing = ""
    public var distinguishingMarks = ""
    public var conditions = ""
    public var medications = ""
    public var allergies = ""
    public var bloodType: BloodType?
    public var needs: Set<MobilityNeed> = []
    public var mobilityNotes = ""
    public var peopleCount = ""
    public var children = ""
    public var elderly = ""
    public var pets: [PetDraft] = []
    public var homeAddress = ""
    public var contactName = ""
    public var contactPhone = ""
    public var contactRelationship = ""
    public var notes = ""

    public init() {}

    public init(_ p: UserProfile) {
        fullName = p.fullName; preferredName = p.preferredName
        birthYear = p.birthYear.map(String.init) ?? ""
        languages = p.languages.joined(separator: ", ")
        phone = p.phone
        heightCm = p.appearance.heightCm.map(String.init) ?? ""
        hair = p.appearance.hair; clothing = p.appearance.clothing; distinguishingMarks = p.appearance.distinguishingMarks
        conditions = p.medical.conditions.joined(separator: ", ")
        medications = p.medical.medications.joined(separator: ", ")
        allergies = p.medical.allergies.joined(separator: ", ")
        bloodType = p.medical.bloodType
        needs = Set(p.mobility.needs); mobilityNotes = p.mobility.notes
        peopleCount = p.household.peopleCount.map(String.init) ?? ""
        children = p.household.children.map(String.init) ?? ""
        elderly = p.household.elderly.map(String.init) ?? ""
        pets = p.household.pets.map { PetDraft(kind: $0.kind, count: $0.count.map(String.init) ?? "") }
        homeAddress = p.homeAddress
        contactName = p.emergencyContact.name; contactPhone = p.emergencyContact.phone; contactRelationship = p.emergencyContact.relationship
        notes = p.notes
    }

    static func split(_ s: String) -> [String] { s.split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == ";" }).map(String.init) }

    /// nil = empty field; `.some(nil)` is not representable, so unparsable text is reported by `validate`.
    static func int(_ s: String) -> Int? { Int(s.trimmingCharacters(in: .whitespaces)) }

    // MARK: Height views

    /// Switches the height view. Going to ft/in shows the stored centimetres in feet and inches (display only, so
    /// cm -> ft/in -> cm without typing never changes the value). Going back to cm needs no conversion because every
    /// ft/in edit already wrote the centimetres.
    public mutating func setHeightSystem(_ system: UnitSystem) {
        guard system != heightSystem else { return }
        heightSystem = system
        if system == .imperial {
            refreshHeightFields()
        }
    }

    /// Feet typed in the ft/in view. Writes `heightCm` whenever the pair is a valid height.
    public mutating func editHeightFeet(_ text: String) {
        heightFeet = text
        heightEditedInImperial = true
        syncHeightCm()
    }

    /// Inches typed in the ft/in view. Writes `heightCm` whenever the pair is a valid height.
    public mutating func editHeightInches(_ text: String) {
        heightInches = text
        heightEditedInImperial = true
        syncHeightCm()
    }

    /// Message for the ft/in fields, nil when they are empty or describe a valid height. Inches may be left empty (0).
    public var heightFeetInchesError: String? {
        let f = heightFeet.trimmingCharacters(in: .whitespaces), i = heightInches.trimmingCharacters(in: .whitespaces)
        if f.isEmpty && i.isEmpty { return nil }
        guard !f.isEmpty else { return "Enter feet too" }
        guard let feet = Int(f), Units.feetRange.contains(feet) else { return "Feet: a whole number from 1 to 8" }
        if !i.isEmpty {
            guard let inches = Int(i), Units.inchesRange.contains(inches) else { return "Inches: a whole number from 0 to 11" }
        }
        let cm = Units.centimeters(feet: feet, inches: Int(i) ?? 0)
        return ProfileLimits.heightRange.contains(cm) ? nil : "Between 1 ft 0 in and 8 ft 6 in"
    }

    private mutating func refreshHeightFields() {
        if let cm = Self.int(heightCm) {
            let (feet, inches) = Units.feetAndInches(cm: cm)
            heightFeet = String(feet)
            heightInches = String(inches)
        } else {
            heightFeet = ""
            heightInches = ""
        }
        heightEditedInImperial = false
    }

    private mutating func syncHeightCm() {
        let f = heightFeet.trimmingCharacters(in: .whitespaces), i = heightInches.trimmingCharacters(in: .whitespaces)
        if f.isEmpty && i.isEmpty {
            heightCm = ""
        } else if heightFeetInchesError == nil, let feet = Int(f) {
            heightCm = String(Units.centimeters(feet: feet, inches: Int(i) ?? 0))
        }
        // An invalid pair leaves heightCm alone; validation reports the fields and blocks saving.
    }

    public func toProfile() -> UserProfile {
        var p = UserProfile(fullName: fullName)
        p.preferredName = preferredName
        p.birthYear = Self.int(birthYear)
        p.languages = Self.split(languages)
        p.phone = phone
        p.appearance = ProfileAppearance(heightCm: Self.int(heightCm), hair: hair, clothing: clothing, distinguishingMarks: distinguishingMarks)
        p.medical = ProfileMedical(conditions: Self.split(conditions), medications: Self.split(medications),
                                   allergies: Self.split(allergies), bloodType: bloodType)
        p.mobility = ProfileMobility(needs: MobilityNeed.allCases.filter(needs.contains), notes: mobilityNotes)
        p.household = ProfileHousehold(peopleCount: Self.int(peopleCount), children: Self.int(children), elderly: Self.int(elderly),
                                       pets: pets.map { ProfilePet(kind: $0.kind, count: Self.int($0.count)) })
        p.homeAddress = homeAddress
        p.emergencyContact = ProfileContact(name: contactName, phone: contactPhone, relationship: contactRelationship)
        p.notes = notes
        return ProfileValidation.cleaned(p)
    }

    /// Field path (same names as the contract, e.g. `appearance.height_cm`) -> message. Empty = ready to save.
    public func validate(nowYear: Int, requireName: Bool = true) -> [String: String] {
        var e = ProfileValidation.validate(toProfile(), nowYear: nowYear, requireName: requireName)
        func number(_ path: String, _ s: String) {
            let t = s.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty, Int(t) == nil { e[path] = "Enter a whole number" }
        }
        number("birth_year", birthYear); number("appearance.height_cm", heightCm)
        if heightEditedInImperial, let message = heightFeetInchesError { e["appearance.height_cm"] = message }
        number("household.people_count", peopleCount); number("household.children", children); number("household.elderly", elderly)
        for (i, pet) in pets.enumerated() { number("household.pets.\(i).count", pet.count) }
        return e
    }

    /// Fraction of the optional sections the user has filled in, for the progress indicator: name counts for half.
    public var completeness: Double {
        let p = toProfile()
        var done = 0.0
        if !p.fullName.isEmpty { done += 0.5 }
        let sections = [p.birthYear != nil || !p.preferredName.isEmpty || !p.languages.isEmpty || !p.phone.isEmpty,
                        !p.appearance.isEmpty, !p.medical.isEmpty || !p.mobility.isEmpty, !p.household.isEmpty,
                        !p.emergencyContact.isEmpty, !p.homeAddress.isEmpty || !p.notes.isEmpty]
        done += 0.5 * Double(sections.filter { $0 }.count) / Double(sections.count)
        return done
    }
}
