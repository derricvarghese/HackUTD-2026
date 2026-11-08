@testable import BeaconMesh
import Foundation
import Testing

private let year = 2026

private func fullProfile() -> UserProfile {
    var p = UserProfile(fullName: "Maria Elena Gonzalez")
    p.preferredName = "Elena"; p.birthYear = 1951; p.languages = ["es", "en"]; p.phone = "+19725550142"
    p.appearance = ProfileAppearance(heightCm: 160, hair: "short grey", clothing: "blue cardigan", distinguishingMarks: "scar on left wrist")
    p.medical = ProfileMedical(conditions: ["type 2 diabetes", "hypertension"], medications: ["insulin glargine"], allergies: ["penicillin"], bloodType: .oPos)
    p.mobility = ProfileMobility(needs: [.walksWithAid, .oxygenDependent], notes: "uses a cane")
    p.household = ProfileHousehold(peopleCount: 3, children: 1, elderly: 1, pets: [ProfilePet(kind: "dog", count: 1)])
    p.homeAddress = "412 Cedar Ln, Richardson, TX 75080"
    p.emergencyContact = ProfileContact(name: "Daniel Gonzalez", phone: "+19725550177", relationship: "son")
    p.notes = "Second floor apartment."
    return p
}

@Suite struct ProfileDeriveTests {
    @Test func ageBucketsMatchTheServerTable() {
        let ages = [0, 12, 13, 17, 18, 34, 35, 49, 50, 64, 65, 79, 80, 100]
        let want = ["0-12", "0-12", "13-17", "13-17", "18-34", "18-34", "35-49", "35-49", "50-64", "50-64", "65-79", "65-79", "80+", "80+"]
        #expect(ages.map { ProfileDerive.ageRange(birthYear: year - $0, nowYear: year)! } == want)
        #expect(ProfileDerive.ageRange(birthYear: nil, nowYear: year) == nil)
        // a birth year after "now" (clock skew) clamps to age 0 like the server's Math.max(0, ...)
        #expect(ProfileDerive.ageRange(birthYear: year + 1, nowYear: year) == "0-12")
    }

    @Test func flagsFollowTheContractRulesInServerOrder() {
        var p = UserProfile(fullName: "A B")
        p.mobility.needs = [.wheelchair, .oxygenDependent, .hearingImpaired]
        p.medical.allergies = ["nuts"]
        #expect(ProfileDerive.flags(p, nowYear: year) == ["oxygen", "mobility", "medical", "sensory"])
        var q = UserProfile(fullName: "A B"); q.birthYear = 1950
        #expect(ProfileDerive.flags(q, nowYear: year) == ["elderly"])
        q.birthYear = 2020
        #expect(ProfileDerive.flags(q, nowYear: year) == ["child"])
        q.birthYear = 1990
        #expect(ProfileDerive.flags(q, nowYear: year).isEmpty)
        q.birthYear = 1961   // exactly 65
        #expect(ProfileDerive.flags(q, nowYear: year) == ["elderly"])
        q.birthYear = 1962   // 64
        #expect(ProfileDerive.flags(q, nowYear: year).isEmpty)
        q.birthYear = 2014   // 12
        #expect(ProfileDerive.flags(q, nowYear: year) == ["child"])
        q.birthYear = 2013   // 13
        #expect(ProfileDerive.flags(q, nowYear: year).isEmpty)
    }

    @Test func eachNeedMapsToItsFlag() {
        func f(_ n: MobilityNeed) -> [String] { var p = UserProfile(fullName: "A B"); p.mobility.needs = [n]; return ProfileDerive.flags(p, nowYear: year) }
        #expect(f(.wheelchair) == ["mobility"]); #expect(f(.cannotWalk) == ["mobility"]); #expect(f(.walksWithAid) == ["mobility"])
        #expect(f(.visionImpaired) == ["sensory"]); #expect(f(.hearingImpaired) == ["sensory"])
        #expect(f(.cognitive) == ["cognitive"]); #expect(f(.oxygenDependent) == ["oxygen"]); #expect(f(.other).isEmpty)
        var p = UserProfile(fullName: "A B"); p.medical.conditions = ["  "]   // blanks do not count
        #expect(ProfileDerive.flags(p, nowYear: year).isEmpty)
    }

    @Test func utcYear() {
        #expect(ProfileDerive.utcYear(ms: 1_794_067_200_000) == 2026)       // 2026-11-07
        #expect(ProfileDerive.utcYear(ms: 1_798_761_599_000) == 2026)       // 2026-12-31T23:59:59Z
        #expect(ProfileDerive.utcYear(ms: 1_798_761_600_000) == 2027)
    }
}

@Suite struct ProfileValidationTests {
    private func issues(_ edit: (inout UserProfile) -> Void) -> [String: String] {
        var p = UserProfile(fullName: "Maria Gonzalez"); edit(&p)
        return ProfileValidation.validate(p, nowYear: year)
    }

    @Test func minimalAndFullAreValid() {
        #expect(issues { _ in }.isEmpty)
        #expect(ProfileValidation.validate(fullProfile(), nowYear: year).isEmpty)
    }

    @Test func nameRules() {
        #expect(issues { $0.fullName = "   " }["full_name"] != nil)
        #expect(issues { $0.fullName = String(repeating: "a", count: 121) }["full_name"] != nil)
        #expect(issues { $0.fullName = String(repeating: "a", count: 120) }.isEmpty)
        #expect(issues { $0.fullName = "Mar\u{0}ia" }["full_name"] != nil)
        #expect(issues { $0.fullName = "Maria\nGonzalez" }["full_name"] != nil)
        #expect(issues { $0.preferredName = String(repeating: "a", count: 61) }["preferred_name"] != nil)
        #expect(ProfileValidation.validate(UserProfile(), nowYear: year, requireName: false).isEmpty)
    }

    @Test func numbersAndPhones() {
        #expect(issues { $0.birthYear = 1899 }["birth_year"] != nil)
        #expect(issues { $0.birthYear = 2027 }["birth_year"] != nil)
        #expect(issues { $0.birthYear = 2026 }.isEmpty)
        #expect(issues { $0.birthYear = 1900 }.isEmpty)
        #expect(issues { $0.appearance.heightCm = 29 }["appearance.height_cm"] != nil)
        #expect(issues { $0.appearance.heightCm = 261 }["appearance.height_cm"] != nil)
        #expect(issues { $0.appearance.heightCm = 260 }.isEmpty)
        for ok in ["+1 (972) 555-0142", "972-555-0142", "+19725550142", "12345 6"] { #expect(ProfileValidation.isValidPhone(ok), "\(ok)") }
        for bad in ["12ab", "123", "+", "abc", "1234 5x6", "+1 972 555 0142 ext", String(repeating: "1", count: 33), "(972) 555-0142"] {
            #expect(!ProfileValidation.isValidPhone(bad), "\(bad)")
        }
        #expect(issues { $0.phone = "nope" }["phone"] != nil)
    }

    @Test func languagesListsAndHousehold() {
        #expect(issues { $0.languages = ["<script>"] }["languages"] != nil)
        #expect(issues { $0.languages = ["e"] }["languages"] != nil)
        #expect(issues { $0.languages = ["es", "en-US", "Español", "日本語"] }.isEmpty)
        #expect(issues { $0.languages = (0..<9).map { "lang\($0)" } }["languages"] != nil)
        #expect(issues { $0.medical.conditions = (0..<21).map { "c\($0)" } }["medical.conditions"] != nil)
        #expect(issues { $0.medical.allergies = [String(repeating: "x", count: 101)] }["medical.allergies"] != nil)
        #expect(issues { $0.household = ProfileHousehold(peopleCount: 2, children: 3) }["household"] != nil)
        #expect(issues { $0.household = ProfileHousehold(peopleCount: 0) }["household.people_count"] != nil)
        #expect(issues { $0.household = ProfileHousehold(peopleCount: 51) }["household.people_count"] != nil)
        #expect(issues { $0.household.pets = [ProfilePet(kind: "dog", count: 100)] }["household.pets.0.count"] != nil)
        #expect(issues { $0.household.pets = Array(repeating: ProfilePet(kind: "cat"), count: 11) }["household.pets"] != nil)
        #expect(issues { $0.homeAddress = String(repeating: "a", count: 301) }["home_address"] != nil)
        #expect(issues { $0.notes = String(repeating: "a", count: 1001) }["notes"] != nil)
        #expect(issues { $0.notes = "line1\nline2" }.isEmpty)   // notes may be multi-line
    }

    @Test func emergencyContactIsAllOrNothing() {
        #expect(issues { $0.emergencyContact = ProfileContact(name: "Dan") }.count == 2)
        #expect(issues { $0.emergencyContact = ProfileContact(name: "Dan", phone: "nope", relationship: "son") }["emergency_contact.phone"] != nil)
        #expect(issues { $0.emergencyContact = ProfileContact(name: "Dan", phone: "+19725550177", relationship: "son") }.isEmpty)
    }

    @Test func messagesNeverEchoTheValue() {
        let secret = "SECRET-PHONE-VALUE"
        let e = issues { $0.phone = secret; $0.birthYear = 1800 }
        #expect(!e.values.joined().contains("SECRET"))
    }

    @Test func cleaningTrimsDedupesAndDropsBlanks() {
        var p = UserProfile(fullName: "  Maria  ")
        p.medical.conditions = ["asthma", " asthma ", ""]
        p.mobility.needs = [.cognitive, .cognitive, .wheelchair]
        p.household.pets = [ProfilePet(kind: "  "), ProfilePet(kind: " dog ", count: 2)]
        let c = ProfileValidation.cleaned(p)
        #expect(c.fullName == "Maria")
        #expect(c.medical.conditions == ["asthma"])
        #expect(c.mobility.needs == [.wheelchair, .cognitive])
        #expect(c.household.pets == [ProfilePet(kind: "dog", count: 2)])
    }
}

@Suite struct ProfileJSONTests {
    private let consent = ProfileConsentInfo(version: "2026-11-v1", acceptedAtMs: 1_794_067_200_000)

    @Test func minimalInputOmitsEverythingEmpty() {
        let j = UserProfile(fullName: "Maria").inputJSON(consent: consent)
        #expect(Set(j.objectValue!.keys) == ["full_name", "consent"])
        #expect(j["consent"] == .object(["accepted": .bool(true), "version": .string("2026-11-v1"), "accepted_at": .string("2026-11-07T16:00:00.000Z")]))
    }

    @Test func fullInputMatchesTheContractExampleShape() throws {
        let j = fullProfile().inputJSON(consent: consent)
        #expect(j.optString("full_name") == "Maria Elena Gonzalez")
        #expect(j["birth_year"]?.intValue == 1951)
        #expect(j["appearance"]?["height_cm"]?.intValue == 160)
        #expect(j["medical"]?["blood_type"]?.stringValue == "O+")
        #expect(j["mobility"]?["needs"] == .array([.string("walks_with_aid"), .string("oxygen_dependent")]))
        #expect(j["household"]?["pets"] == .array([.object(["kind": .string("dog"), "count": .int(1)])]))
        #expect(j["emergency_contact"]?.optString("relationship") == "son")
        // the canonical writer must accept it (no NaN, only supported types)
        _ = try j.canonical()
    }

    @Test func emptyGroupsAreNotSent() {
        var p = UserProfile(fullName: "Maria"); p.appearance.hair = "  "; p.medical.conditions = [""]; p.household.pets = [ProfilePet(kind: "")]
        #expect(p.inputJSON(consent: consent).objectValue!.keys.sorted() == ["consent", "full_name"])
    }

    @Test func serverFullRoundTrips() {
        let sent = fullProfile().inputJSON(consent: consent)
        var full = sent.objectValue!
        full["view"] = .string("full"); full["profile_version"] = .int(3); full["vulnerability_flags"] = .array([.string("elderly")])
        #expect(UserProfile.fromJSON(.object(full)) == ProfileValidation.cleaned(fullProfile()))
        #expect(UserProfile.fromJSON(.object(["x": .int(1)])) == nil)
    }

    @Test func recordRoundTrips() {
        var r = ProfileRecord()
        r.profile = fullProfile(); r.base = UserProfile(fullName: "Maria"); r.consentVersion = "2026-11-v1"; r.serverVersion = 4
        r.dirty = true; r.revision = 9; r.needsConsent = true; r.lastError = "HTTP 500"; r.deletePending = true
        #expect(ProfileRecord.fromJSON(JSONValue.parse(r.toJSON().serialized())!) == r)
    }

    @Test func threeWayMergeKeepsLocalEditsAndTakesServerChanges() {
        let base = fullProfile()
        var local = base; local.phone = "+19725550999"                      // I edited the phone
        var server = base; server.homeAddress = "1 New St"; server.phone = "+10000000000"   // other copy changed address and phone
        let m = UserProfile.merge(local: local, base: base, server: server)
        #expect(m.phone == "+19725550999")
        #expect(m.homeAddress == "1 New St")
        // no base (first sync): local wins, the server fills gaps
        var bare = UserProfile(fullName: "Maria"); bare.phone = "+19725550001"
        let m2 = UserProfile.merge(local: bare, base: nil, server: fullProfile())
        #expect(m2.phone == "+19725550001" && m2.homeAddress == fullProfile().homeAddress && m2.fullName == "Maria")
        // a field I cleared stays cleared
        var cleared = base; cleared.notes = ""
        #expect(UserProfile.merge(local: cleared, base: base, server: base).notes.isEmpty)
    }
}

@Suite struct ProfileDraftTests {
    @Test func roundTripAndParsing() {
        let d = ProfileDraft(fullProfile())
        #expect(d.toProfile() == ProfileValidation.cleaned(fullProfile()))
        var e = ProfileDraft(); e.fullName = "A B"; e.languages = "es, en\nfr;de"; e.conditions = "asthma,, asthma"
        let p = e.toProfile()
        #expect(p.languages == ["es", "en", "fr", "de"] && p.medical.conditions == ["asthma"])
    }

    @Test func numbersMustBeNumbers() {
        var d = ProfileDraft(); d.fullName = "A B"; d.birthYear = "19x5"; d.heightCm = "tall"; d.pets = [.init(kind: "dog", count: "two")]
        let e = d.validate(nowYear: year)
        #expect(e["birth_year"] != nil && e["appearance.height_cm"] != nil && e["household.pets.0.count"] != nil)
        d.birthYear = "1985"; d.heightCm = "170"; d.pets = [.init(kind: "dog", count: "2")]
        #expect(d.validate(nowYear: year).isEmpty)
        #expect(ProfileDraft().validate(nowYear: year)["full_name"] != nil)
        #expect(ProfileDraft().validate(nowYear: year, requireName: false).isEmpty)
    }

    @Test func completenessGrows() {
        var d = ProfileDraft()
        #expect(d.completeness == 0)
        d.fullName = "A B"
        #expect(d.completeness == 0.5)
        #expect(ProfileDraft(fullProfile()).completeness == 1)
    }
}

@Suite struct ProfileSummaryTests {
    @Test func buildsTheContractShape() {
        var p = fullProfile(); p.mobility.needs = [.oxygenDependent]; p.medical = ProfileMedical()
        let s = ProfileSummary.build(p, profileVersion: 0, nowYear: year)!
        #expect(s == .object(["full_name": .string("Maria Elena Gonzalez"), "age_range": .string("65-79"),
                              "vulnerability_flags": .array([.string("oxygen"), .string("elderly")]), "profile_version": .int(0)]))
        #expect(ProfileSummary.build(UserProfile(), profileVersion: 1, nowYear: year) == nil)
        let bare = ProfileSummary.build(UserProfile(fullName: "Sam"), profileVersion: 2, nowYear: year)!
        #expect(Set(bare.objectValue!.keys) == ["full_name", "profile_version"])
    }

    @Test func nameIsCappedAt120() {
        let s = ProfileSummary.build(UserProfile(fullName: String(repeating: "é", count: 200)), profileVersion: 0, nowYear: year)!
        #expect(s.optString("full_name")!.utf16.count == 120)
    }

    @Test func worstCaseEnvelopeStillFitsTheTransport() throws {
        let b = TestBackend()
        let cfg = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: b.encPublicB64)
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), config: cfg, now: { 1_794_067_200_000 })
        var p = UserProfile(fullName: String(repeating: "中", count: 120))
        p.birthYear = 1930; p.medical.conditions = ["x"]; p.mobility.needs = MobilityNeed.allCases
        let summary = ProfileSummary.build(p, profileVersion: 123_456, nowYear: year)!
        #expect(summary.serializedData().count < 800)   // CJK name is escaped-free UTF-8: 360 bytes + flags
        let worstText = String(repeating: "中", count: 1000)
        let without = try router.originate(category: .trapped, text: worstText, lat: 32.9857, lng: -96.7501, accuracy: 8.5, people: 50)
        router.profileSummary = { summary }
        let withProfile = try router.originate(category: .trapped, text: worstText, lat: 32.9857, lng: -96.7501, accuracy: 8.5, people: 50)
        let bytes = withProfile.envelope.toBytes()
        // BLE: 64 chunks max; the weakest supported write length used by the app is >= 100 bytes
        #expect(!Framing.chunk(bytes, transferId: 1, maxWriteLength: 100).isEmpty, "envelope \(bytes.count) bytes")
        // the summary costs at most ~700 bytes of envelope even with a 120 character CJK name (ciphertext is base64)
        #expect(bytes.count - without.envelope.toBytes().count < 700, "delta \(bytes.count - without.envelope.toBytes().count)")
        #expect(try b.decrypt(withProfile.envelope)["profile_summary"] == summary)
    }

    @Test func onlySosAndSafeCarryTheSummary() throws {
        let b = TestBackend()
        let cfg = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: b.encPublicB64)
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), config: cfg, now: { 1_794_067_200_000 })
        let summary = ProfileSummary.build(UserProfile(fullName: "Sam"), profileVersion: 0, nowYear: year)!
        router.profileSummary = { summary }
        #expect(try b.decrypt(router.originate(category: .safe, lat: 1, lng: 2).envelope)["profile_summary"] == summary)
        #expect(try b.decrypt(router.originateCheckinReply(checkinId: Uuid7.generate(), response: "ok", lat: 1, lng: 2).envelope)["profile_summary"] == nil)
        #expect(try b.decrypt(router.originateHeartbeat(lat: 1, lng: 2, batteryPct: 5, charging: false, moving: false, seq: 1).envelope)["profile_summary"] == nil)
        router.profileSummary = { nil }
        #expect(try b.decrypt(router.originate(category: .trapped, lat: 1, lng: 2).envelope)["profile_summary"] == nil)
    }
}
