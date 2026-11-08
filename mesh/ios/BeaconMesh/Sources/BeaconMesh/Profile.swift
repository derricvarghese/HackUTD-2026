import Foundation

// The user's identity profile (openapi `ProfileInput`). Pure value types: no I/O, compiled and tested on Linux.
// Rules mirror server/src/domain/profile.ts. NEVER log values of these types (the logger helpers below only take field names).

public enum BloodType: String, CaseIterable, Equatable {
    case aPos = "A+", aNeg = "A-", bPos = "B+", bNeg = "B-", abPos = "AB+", abNeg = "AB-", oPos = "O+", oNeg = "O-", unknown
}

/// `ProfileMobility.needs[]`, in the contract's order.
public enum MobilityNeed: String, CaseIterable, Equatable {
    case wheelchair, cannotWalk = "cannot_walk", walksWithAid = "walks_with_aid", visionImpaired = "vision_impaired"
    case hearingImpaired = "hearing_impaired", cognitive, oxygenDependent = "oxygen_dependent", other
}

public struct ProfileAppearance: Equatable {
    public var heightCm: Int?
    public var hair = ""
    public var clothing = ""
    public var distinguishingMarks = ""
    public init(heightCm: Int? = nil, hair: String = "", clothing: String = "", distinguishingMarks: String = "") {
        self.heightCm = heightCm; self.hair = hair; self.clothing = clothing; self.distinguishingMarks = distinguishingMarks
    }
    public var isEmpty: Bool { self == ProfileAppearance() }
}

public struct ProfileMedical: Equatable {
    public var conditions: [String] = []
    public var medications: [String] = []
    public var allergies: [String] = []
    public var bloodType: BloodType?
    public init(conditions: [String] = [], medications: [String] = [], allergies: [String] = [], bloodType: BloodType? = nil) {
        self.conditions = conditions; self.medications = medications; self.allergies = allergies; self.bloodType = bloodType
    }
    public var isEmpty: Bool { self == ProfileMedical() }
}

public struct ProfileMobility: Equatable {
    public var needs: [MobilityNeed] = []
    public var notes = ""
    public init(needs: [MobilityNeed] = [], notes: String = "") { self.needs = needs; self.notes = notes }
    public var isEmpty: Bool { self == ProfileMobility() }
}

public struct ProfilePet: Equatable {
    public var kind: String
    public var count: Int?
    public init(kind: String, count: Int? = nil) { self.kind = kind; self.count = count }
}

public struct ProfileHousehold: Equatable {
    public var peopleCount: Int?
    public var children: Int?
    public var elderly: Int?
    public var pets: [ProfilePet] = []
    public init(peopleCount: Int? = nil, children: Int? = nil, elderly: Int? = nil, pets: [ProfilePet] = []) {
        self.peopleCount = peopleCount; self.children = children; self.elderly = elderly; self.pets = pets
    }
    public var isEmpty: Bool { self == ProfileHousehold() }
}

public struct ProfileContact: Equatable {
    public var name = ""
    public var phone = ""
    public var relationship = ""
    public init(name: String = "", phone: String = "", relationship: String = "") {
        self.name = name; self.phone = phone; self.relationship = relationship
    }
    public var isEmpty: Bool { self == ProfileContact() }
}

public struct UserProfile: Equatable {
    public var fullName = ""
    public var preferredName = ""
    public var birthYear: Int?
    public var languages: [String] = []
    public var phone = ""
    public var appearance = ProfileAppearance()
    public var medical = ProfileMedical()
    public var mobility = ProfileMobility()
    public var household = ProfileHousehold()
    public var homeAddress = ""
    public var emergencyContact = ProfileContact()
    public var notes = ""

    public init() {}
    public init(fullName: String) { self.fullName = fullName }
}

// MARK: - Limits

public enum ProfileLimits {
    public static let fullName = 120, preferredName = 60, languages = 8, languageMin = 2, languageMax = 35
    public static let heightRange = 30...260, birthYearMin = 1900
    public static let appearanceText = 300, listItems = 20, listItemLength = 100, mobilityNotes = 300
    public static let people = 1...50, childrenElderly = 0...50, pets = 10, petKind = 40, petCount = 1...99
    public static let address = 300, contactName = 120, relationship = 60, notes = 1000, phoneMax = 32
}

// MARK: - Cleaning and validation

public enum ProfileValidation {
    /// `^\+?[0-9][0-9 ()\-.]{4,24}[0-9]$`, max 32 characters (ProfileInput.phone and emergency_contact.phone).
    public static func isValidPhone(_ s: String) -> Bool {
        let u = Array(s.unicodeScalars)
        guard u.count <= ProfileLimits.phoneMax else { return false }
        var i = 0
        if i < u.count, u[i] == "+" { i += 1 }
        let rest = Array(u[i...])
        guard rest.count >= 6 else { return false }   // digit + 4 middle + digit
        func digit(_ c: Unicode.Scalar) -> Bool { c.value >= 0x30 && c.value <= 0x39 }
        guard digit(rest.first!), digit(rest.last!) else { return false }
        let middle = rest[1..<(rest.count - 1)]
        guard (4...24).contains(middle.count) else { return false }
        return middle.allSatisfy { digit($0) || " ()-.".unicodeScalars.contains($0) }
    }

    static func hasControl(_ s: String, multiline: Bool) -> Bool {
        s.unicodeScalars.contains { c in
            let v = c.value
            if v == 0x7f { return true }
            if v < 0x20 { return multiline ? !(v == 9 || v == 10 || v == 13) : true }
            return false
        }
    }

    static func isLanguage(_ s: String) -> Bool {
        let n = s.utf16.count
        guard (ProfileLimits.languageMin...ProfileLimits.languageMax).contains(n) else { return false }
        return s.unicodeScalars.allSatisfy { c in
            switch c.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                 .nonspacingMark, .spacingMark, .enclosingMark: return true
            default: return c == " " || c == "_" || c == "-" || (c.value >= 0x30 && c.value <= 0x39)
            }
        }
    }

    static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func list(_ a: [String]) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for x in a.map(trimmed) where !x.isEmpty && seen.insert(x).inserted { out.append(x) }
        return out
    }

    /// Trimmed copy: blanks dropped, lists de-duplicated, empty groups reset (same cleaning the server applies).
    public static func cleaned(_ p: UserProfile) -> UserProfile {
        var o = UserProfile()
        o.fullName = trimmed(p.fullName)
        o.preferredName = trimmed(p.preferredName)
        o.birthYear = p.birthYear
        o.languages = list(p.languages)
        o.phone = trimmed(p.phone)
        o.appearance = ProfileAppearance(heightCm: p.appearance.heightCm, hair: trimmed(p.appearance.hair),
                                         clothing: trimmed(p.appearance.clothing),
                                         distinguishingMarks: trimmed(p.appearance.distinguishingMarks))
        o.medical = ProfileMedical(conditions: list(p.medical.conditions), medications: list(p.medical.medications),
                                   allergies: list(p.medical.allergies), bloodType: p.medical.bloodType)
        var seenNeeds = Set<MobilityNeed>()
        o.mobility = ProfileMobility(needs: MobilityNeed.allCases.filter { p.mobility.needs.contains($0) && seenNeeds.insert($0).inserted },
                                     notes: trimmed(p.mobility.notes))
        o.household = ProfileHousehold(peopleCount: p.household.peopleCount, children: p.household.children,
                                       elderly: p.household.elderly,
                                       pets: p.household.pets.compactMap { pet in
                                           let k = trimmed(pet.kind)
                                           return k.isEmpty ? nil : ProfilePet(kind: k, count: pet.count)
                                       })
        o.homeAddress = trimmed(p.homeAddress)
        o.emergencyContact = ProfileContact(name: trimmed(p.emergencyContact.name), phone: trimmed(p.emergencyContact.phone),
                                            relationship: trimmed(p.emergencyContact.relationship))
        o.notes = trimmed(p.notes)
        return o
    }

    /// Field path -> message. Messages never contain the submitted value. Empty result = valid.
    /// `requireName` is false only for tests of optional parts.
    public static func validate(_ raw: UserProfile, nowYear: Int, requireName: Bool = true) -> [String: String] {
        let p = cleaned(raw)
        var e: [String: String] = [:]
        func text(_ path: String, _ v: String, max: Int, multiline: Bool = false) {
            if v.utf16.count > max { e[path] = "At most \(max) characters" }
            else if hasControl(v, multiline: multiline) { e[path] = "Contains characters that are not allowed" }
        }
        if p.fullName.isEmpty { if requireName { e["full_name"] = "Enter your name" } }
        else { text("full_name", p.fullName, max: ProfileLimits.fullName) }
        text("preferred_name", p.preferredName, max: ProfileLimits.preferredName)
        if let y = p.birthYear, y < ProfileLimits.birthYearMin || y > nowYear { e["birth_year"] = "Enter a year between \(ProfileLimits.birthYearMin) and \(nowYear)" }
        if p.languages.count > ProfileLimits.languages { e["languages"] = "At most \(ProfileLimits.languages) languages" }
        else if !p.languages.allSatisfy(isLanguage) { e["languages"] = "Use a language name or code, 2 to 35 letters" }
        if !p.phone.isEmpty, !isValidPhone(p.phone) { e["phone"] = "Enter a phone number such as +1 972 555 0142" }
        if let h = p.appearance.heightCm, !ProfileLimits.heightRange.contains(h) { e["appearance.height_cm"] = "Between 30 and 260 cm" }
        text("appearance.hair", p.appearance.hair, max: ProfileLimits.appearanceText)
        text("appearance.clothing", p.appearance.clothing, max: ProfileLimits.appearanceText)
        text("appearance.distinguishing_marks", p.appearance.distinguishingMarks, max: ProfileLimits.appearanceText)
        for (path, items) in [("medical.conditions", p.medical.conditions), ("medical.medications", p.medical.medications),
                              ("medical.allergies", p.medical.allergies)] {
            if items.count > ProfileLimits.listItems { e[path] = "At most \(ProfileLimits.listItems) items" }
            else if items.contains(where: { $0.utf16.count > ProfileLimits.listItemLength || hasControl($0, multiline: false) }) {
                e[path] = "Each item can have at most \(ProfileLimits.listItemLength) characters"
            }
        }
        text("mobility.notes", p.mobility.notes, max: ProfileLimits.mobilityNotes, multiline: true)
        let h = p.household
        if let n = h.peopleCount, !ProfileLimits.people.contains(n) { e["household.people_count"] = "Between 1 and 50" }
        if let n = h.children, !ProfileLimits.childrenElderly.contains(n) { e["household.children"] = "Between 0 and 50" }
        if let n = h.elderly, !ProfileLimits.childrenElderly.contains(n) { e["household.elderly"] = "Between 0 and 50" }
        if let pc = h.peopleCount, (h.children ?? 0) > pc || (h.elderly ?? 0) > pc { e["household"] = "Children and elderly cannot exceed the number of people" }
        if h.pets.count > ProfileLimits.pets { e["household.pets"] = "At most \(ProfileLimits.pets) kinds of pets" }
        for (i, pet) in h.pets.enumerated() {
            if pet.kind.utf16.count > ProfileLimits.petKind || hasControl(pet.kind, multiline: false) { e["household.pets.\(i).kind"] = "At most \(ProfileLimits.petKind) characters" }
            if let c = pet.count, !ProfileLimits.petCount.contains(c) { e["household.pets.\(i).count"] = "Between 1 and 99" }
        }
        text("home_address", p.homeAddress, max: ProfileLimits.address, multiline: true)
        let c = p.emergencyContact
        if !c.isEmpty {
            if c.name.isEmpty { e["emergency_contact.name"] = "Enter the contact's name" } else { text("emergency_contact.name", c.name, max: ProfileLimits.contactName) }
            if c.phone.isEmpty || !isValidPhone(c.phone) { e["emergency_contact.phone"] = "Enter a phone number such as +1 972 555 0177" }
            if c.relationship.isEmpty { e["emergency_contact.relationship"] = "For example mother, friend, neighbour" } else { text("emergency_contact.relationship", c.relationship, max: ProfileLimits.relationship) }
        }
        text("notes", p.notes, max: ProfileLimits.notes, multiline: true)
        return e
    }
}

// MARK: - Derived values (same rules as server/src/domain/profile.ts)

public enum ProfileDerive {
    public static let ageRanges = ["0-12", "13-17", "18-34", "35-49", "50-64", "65-79", "80+"]
    /// Order in which the server lists flags (`FLAG_ORDER`).
    public static let flagOrder = ["oxygen", "mobility", "medical", "sensory", "cognitive", "elderly", "child"]

    /// UTC calendar year of a millisecond timestamp (the server uses `getUTCFullYear`).
    public static func utcYear(ms: Int64) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal.component(.year, from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    /// Current year minus birth year, never negative; may be off by one (by design).
    public static func age(birthYear: Int?, nowYear: Int) -> Int? { birthYear.map { max(0, nowYear - $0) } }

    public static func ageRange(birthYear: Int?, nowYear: Int) -> String? {
        guard let a = age(birthYear: birthYear, nowYear: nowYear) else { return nil }
        switch a {
        case ...12: return "0-12"
        case 13...17: return "13-17"
        case 18...34: return "18-34"
        case 35...49: return "35-49"
        case 50...64: return "50-64"
        case 65...79: return "65-79"
        default: return "80+"
        }
    }

    /// `VulnerabilityFlag`s: mobility (wheelchair / cannot_walk / walks_with_aid), oxygen (oxygen_dependent), sensory
    /// (vision/hearing impaired), cognitive, medical (any condition, medication or allergy), elderly (age >= 65),
    /// child (age <= 12). Ordered like the server's `FLAG_ORDER`.
    public static func flags(_ raw: UserProfile, nowYear: Int) -> [String] {
        let p = ProfileValidation.cleaned(raw)
        var s = Set<String>()
        let needs = Set(p.mobility.needs)
        if !needs.isDisjoint(with: [.wheelchair, .cannotWalk, .walksWithAid]) { s.insert("mobility") }
        if needs.contains(.oxygenDependent) { s.insert("oxygen") }
        if !needs.isDisjoint(with: [.visionImpaired, .hearingImpaired]) { s.insert("sensory") }
        if needs.contains(.cognitive) { s.insert("cognitive") }
        if !p.medical.conditions.isEmpty || !p.medical.medications.isEmpty || !p.medical.allergies.isEmpty { s.insert("medical") }
        if let a = age(birthYear: p.birthYear, nowYear: nowYear) {
            if a >= 65 { s.insert("elderly") }
            if a <= 12 { s.insert("child") }
        }
        return flagOrder.filter(s.contains)
    }
}

// MARK: - JSON (ProfileInput / ProfileFull)

public struct ProfileConsentInfo: Equatable {
    public var version: String
    public var acceptedAtMs: Int64
    public init(version: String, acceptedAtMs: Int64) { self.version = version; self.acceptedAtMs = acceptedAtMs }
}

extension UserProfile {
    /// Every field except `consent`. Empty fields are omitted (PUT is a full replace, so omission = removal).
    public func fieldsJSON() -> [String: JSONValue] {
        let p = ProfileValidation.cleaned(self)
        var o: [String: JSONValue] = ["full_name": .string(p.fullName)]
        if !p.preferredName.isEmpty { o["preferred_name"] = .string(p.preferredName) }
        if let y = p.birthYear { o["birth_year"] = .int(Int64(y)) }
        if !p.languages.isEmpty { o["languages"] = .array(p.languages.map(JSONValue.string)) }
        if !p.phone.isEmpty { o["phone"] = .string(p.phone) }
        var a: [String: JSONValue] = [:]
        if let h = p.appearance.heightCm { a["height_cm"] = .int(Int64(h)) }
        if !p.appearance.hair.isEmpty { a["hair"] = .string(p.appearance.hair) }
        if !p.appearance.clothing.isEmpty { a["clothing"] = .string(p.appearance.clothing) }
        if !p.appearance.distinguishingMarks.isEmpty { a["distinguishing_marks"] = .string(p.appearance.distinguishingMarks) }
        if !a.isEmpty { o["appearance"] = .object(a) }
        var m: [String: JSONValue] = [:]
        if !p.medical.conditions.isEmpty { m["conditions"] = .array(p.medical.conditions.map(JSONValue.string)) }
        if !p.medical.medications.isEmpty { m["medications"] = .array(p.medical.medications.map(JSONValue.string)) }
        if !p.medical.allergies.isEmpty { m["allergies"] = .array(p.medical.allergies.map(JSONValue.string)) }
        if let b = p.medical.bloodType { m["blood_type"] = .string(b.rawValue) }
        if !m.isEmpty { o["medical"] = .object(m) }
        var mo: [String: JSONValue] = [:]
        if !p.mobility.needs.isEmpty { mo["needs"] = .array(p.mobility.needs.map { .string($0.rawValue) }) }
        if !p.mobility.notes.isEmpty { mo["notes"] = .string(p.mobility.notes) }
        if !mo.isEmpty { o["mobility"] = .object(mo) }
        var h: [String: JSONValue] = [:]
        if let n = p.household.peopleCount { h["people_count"] = .int(Int64(n)) }
        if let n = p.household.children { h["children"] = .int(Int64(n)) }
        if let n = p.household.elderly { h["elderly"] = .int(Int64(n)) }
        if !p.household.pets.isEmpty {
            h["pets"] = .array(p.household.pets.map { pet in
                var d: [String: JSONValue] = ["kind": .string(pet.kind)]
                if let c = pet.count { d["count"] = .int(Int64(c)) }
                return .object(d)
            })
        }
        if !h.isEmpty { o["household"] = .object(h) }
        if !p.homeAddress.isEmpty { o["home_address"] = .string(p.homeAddress) }
        let c = p.emergencyContact
        if !c.isEmpty { o["emergency_contact"] = .object(["name": .string(c.name), "phone": .string(c.phone), "relationship": .string(c.relationship)]) }
        if !p.notes.isEmpty { o["notes"] = .string(p.notes) }
        return o
    }

    /// Body of `PUT /v1/devices/{id}/profile`.
    public func inputJSON(consent: ProfileConsentInfo) -> JSONValue {
        var o = fieldsJSON()
        o["consent"] = .object(["accepted": .bool(true), "version": .string(consent.version),
                                "accepted_at": .string(Iso.format(consent.acceptedAtMs))])
        return .object(o)
    }

    /// Tolerant parse of `ProfileFull` / `ProfileInput` (unknown fields and bad values are ignored). Nil without a name.
    public static func fromJSON(_ j: JSONValue) -> UserProfile? {
        guard j.objectValue != nil, let name = j.optString("full_name") else { return nil }
        var p = UserProfile(fullName: name)
        p.preferredName = j.optString("preferred_name") ?? ""
        p.birthYear = j["birth_year"]?.intValue
        p.languages = stringList(j["languages"])
        p.phone = j.optString("phone") ?? ""
        if let a = j["appearance"], a.objectValue != nil {
            p.appearance = ProfileAppearance(heightCm: a["height_cm"]?.intValue, hair: a.optString("hair") ?? "",
                                             clothing: a.optString("clothing") ?? "", distinguishingMarks: a.optString("distinguishing_marks") ?? "")
        }
        if let m = j["medical"], m.objectValue != nil {
            p.medical = ProfileMedical(conditions: stringList(m["conditions"]), medications: stringList(m["medications"]),
                                       allergies: stringList(m["allergies"]), bloodType: m.optString("blood_type").flatMap(BloodType.init(rawValue:)))
        }
        if let m = j["mobility"], m.objectValue != nil {
            p.mobility = ProfileMobility(needs: stringList(m["needs"]).compactMap(MobilityNeed.init(rawValue:)), notes: m.optString("notes") ?? "")
        }
        if let h = j["household"], h.objectValue != nil {
            let pets: [ProfilePet] = (h["pets"]?.arrayValue ?? []).compactMap { d in
                d.optString("kind").map { ProfilePet(kind: $0, count: d["count"]?.intValue) }
            }
            p.household = ProfileHousehold(peopleCount: h["people_count"]?.intValue, children: h["children"]?.intValue,
                                           elderly: h["elderly"]?.intValue, pets: pets)
        }
        p.homeAddress = j.optString("home_address") ?? ""
        if let c = j["emergency_contact"], c.objectValue != nil {
            p.emergencyContact = ProfileContact(name: c.optString("name") ?? "", phone: c.optString("phone") ?? "", relationship: c.optString("relationship") ?? "")
        }
        p.notes = j.optString("notes") ?? ""
        return ProfileValidation.cleaned(p)
    }

    /// Field-level three-way merge used after a 409: for each top-level field, a local edit (differs from `base`) wins,
    /// otherwise the server's value is taken. Without a base (first sync) local values win and the server fills the gaps.
    public static func merge(local: UserProfile, base: UserProfile?, server: UserProfile) -> UserProfile {
        let l = local.fieldsJSON(), s = server.fieldsJSON(), b = base?.fieldsJSON()
        var out: [String: JSONValue] = [:]
        for k in Set(l.keys).union(s.keys).union(b?.keys.map { $0 } ?? []) {
            let lv = l[k], sv = s[k]
            let chosen: JSONValue?
            if let b { chosen = (lv == b[k]) ? sv : lv } else { chosen = lv ?? sv }
            if let chosen { out[k] = chosen }
        }
        if out["full_name"] == nil { out["full_name"] = .string(local.fullName) }
        return fromJSON(.object(out)) ?? local
    }
}

// MARK: - Mesh summary

public enum ProfileSummary {
    /// openapi `ProfileSummary`: {full_name, age_range?, vulnerability_flags?, profile_version}. Small by construction
    /// (name <= 120 chars; <= 7 short flags). Nil when there is no name. `profileVersion` = last version the server acknowledged (0 = never).
    public static func build(_ p: UserProfile, profileVersion: Int, nowYear: Int) -> JSONValue? {
        let c = ProfileValidation.cleaned(p)
        guard !c.fullName.isEmpty else { return nil }
        var name = c.fullName
        while name.utf16.count > ProfileLimits.fullName { name.removeLast() }
        var o: [String: JSONValue] = ["full_name": .string(name), "profile_version": .int(Int64(max(0, profileVersion)))]
        if let r = ProfileDerive.ageRange(birthYear: c.birthYear, nowYear: nowYear) { o["age_range"] = .string(r) }
        let f = ProfileDerive.flags(c, nowYear: nowYear)
        if !f.isEmpty { o["vulnerability_flags"] = .array(f.map(JSONValue.string)) }
        return .object(o)
    }
}
