@testable import BeaconMesh
import Foundation
import Testing

@Suite struct ResponderPresenceTests {
    private func client(_ http: FakeHTTP) -> ResponderClient {
        let tokens = ResponderTokens(accessToken: "AT-123", refreshToken: "RT-456", accessExpiresAtMs: Int64.max / 2,
                                     account: ResponderAccount(id: "r-99", username: "medic1", name: "Medic One", role: "responder"))
        return ResponderClient(baseURL: "https://example.test/v1/", http: http, store: InMemoryResponderTokenStore(tokens))
    }

    @Test func onlinePresenceSendsExpectedPayloadAndUpdatesAccount() async throws {
        let http = FakeHTTP()
        let respJSON = """
        {
            "id": "r-99",
            "username": "medic1",
            "name": "Medic One",
            "role": "responder",
            "available": true,
            "in_app": true
        }
        """
        http.handler = { _ in HTTPResponse(status: 200, data: Data(respJSON.utf8)) }
        let c = client(http)

        let account = try await c.setPresence(state: "online", client: "app")
        #expect(http.paths() == ["PUT /v1/auth/me/presence"])
        #expect(http.requests[0].headers["Authorization"] == "Bearer AT-123")

        let body = JSONValue.parse(http.requests[0].body)!
        #expect(body["state"]?.stringValue == "online")
        #expect(body["client"]?.stringValue == "app")

        #expect(account?.available == true)
        #expect(c.account?.available == true)
    }

    @Test func offlinePresenceSendsOfflineState() async throws {
        let http = FakeHTTP()
        let respJSON = """
        {
            "id": "r-99",
            "username": "medic1",
            "name": "Medic One",
            "role": "responder",
            "available": false,
            "in_app": false
        }
        """
        http.handler = { _ in HTTPResponse(status: 200, data: Data(respJSON.utf8)) }
        let c = client(http)

        let account = try await c.setPresence(state: "offline", client: "app")
        #expect(http.paths() == ["PUT /v1/auth/me/presence"])

        let body = JSONValue.parse(http.requests[0].body)!
        #expect(body["state"]?.stringValue == "offline")
        #expect(body["client"]?.stringValue == "app")

        #expect(account?.available == false)
        #expect(c.account?.available == false)
    }

    @Test func patchSelfSendsXBeaconClientAppHeader() async throws {
        let http = FakeHTTP()
        http.handler = { _ in HTTPResponse(status: 200, data: Data("{}".utf8)) }
        let c = client(http)

        // 1. Send location update
        try await c.sendLocation(SharedPosition(lat: 32.99, lng: -96.75))
        #expect(http.requests[0].headers["X-Beacon-Client"] == "app")

        // 2. Clear location (location: null)
        try await c.sendLocation(nil)
        #expect(http.requests[1].headers["X-Beacon-Client"] == "app")

        // 3. Toggle availability
        try await c.setAvailable(false)
        #expect(http.requests[2].headers["X-Beacon-Client"] == "app")
        let b2 = JSONValue.parse(http.requests[2].body)!
        #expect(b2["available"]?.boolValue == false)
    }

    @Test func webSocketURLIncludesClientApp() throws {
        let http = FakeHTTP()
        let c = client(http)
        let url = c.webSocketURL()
        #expect(url?.absoluteString == "wss://example.test/v1/ws?token=AT-123&client=app")
    }
}

@Suite struct CaseImageUploadQueueTests {
    @Test func enforcesMaxSixImagesPerCase() throws {
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store)
        let sosId = "sos-case-1"

        for i in 1...6 {
            let item = try queue.enqueue(sosId: sosId, data: Data([UInt8(i)]), caption: "Image \(i)")
            #expect(item.sosId == sosId)
        }
        #expect(queue.queuedCount(for: sosId) == 6)

        // 7th image throws maxImagesReached
        #expect(throws: CaseImageError.maxImagesReached(max: 6)) {
            try queue.enqueue(sosId: sosId, data: Data([7]), caption: "Image 7")
        }

        // Another case can still enqueue
        try queue.enqueue(sosId: "sos-case-2", data: Data([1]))
        #expect(queue.queuedCount(for: "sos-case-2") == 1)
    }

    @Test func truncatesCaptionToTwoHundredChars() throws {
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store)
        let longCaption = String(repeating: "A", count: 250)

        let item = try queue.enqueue(sosId: "case-caption", data: Data([1, 2, 3]), caption: longCaption)
        #expect(item.caption?.count == 200)
        #expect(item.caption == String(repeating: "A", count: 200))
    }

    @Test func emptyDataIsRefused() {
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store)
        #expect(throws: CaseImageError.emptyData) {
            try queue.enqueue(sosId: "case-empty", data: Data())
        }
    }

    @Test func flushSuccessRemovesImage() async throws {
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store)
        try queue.enqueue(sosId: "case-success", data: Data([1, 2, 3]))
        #expect(queue.allPending().count == 1)

        let uploaded = await queue.flush { item in
            #expect(item.sosId == "case-success")
            return .success(nil)
        }
        #expect(uploaded == 1)
        #expect(queue.allPending().isEmpty)
    }

    @Test func flushDropRemovesImageOnTerminalErrors() async throws {
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store)
        try queue.enqueue(sosId: "case-drop", data: Data([1, 2, 3]))

        let uploaded = await queue.flush { _ in
            .drop(status: 409, message: "case full")
        }
        #expect(uploaded == 0)
        #expect(queue.allPending().isEmpty)
    }

    @Test func flushRetryAppliesBackoff() async throws {
        var clock: Int64 = 1_000_000
        let store = InMemoryCaseImageStore()
        let queue = CaseImageUploadQueue(store: store, now: { clock })
        _ = try queue.enqueue(sosId: "case-retry", data: Data([1, 2, 3]))

        // First flush returns retry
        let count = await queue.flush { _ in .retry(afterSeconds: 15) }
        #expect(count == 0)
        let pending = queue.allPending()
        #expect(pending.count == 1)
        #expect(pending[0].attempts == 1)
        #expect(pending[0].nextRetryMs >= clock + 15_000)

        // Flushed before nextRetryMs does nothing
        clock += 5_000
        var called = false
        _ = await queue.flush { _ in called = true; return .success(nil) }
        #expect(!called)

        // Flushed after nextRetryMs executes
        clock += 15_000
        _ = await queue.flush { _ in called = true; return .success(nil) }
        #expect(called)
        #expect(queue.allPending().isEmpty)
    }
}

@Suite struct MeshPayloadSosImageTests {
    @Test func includesImageCountAndHasImagesWhenPresent() {
        let payload = MeshPayload.sos(
            category: .injured,
            text: "Need assistance",
            lat: 32.985,
            lng: -96.755,
            accuracy: 10.0,
            people: 2,
            imageCount: 3
        )
        #expect(payload["has_images"]?.boolValue == true)
        #expect(payload["image_count"]?.intValue == 3)
    }

    @Test func capsImageCountAtFifty() {
        let payload = MeshPayload.sos(
            category: .trapped,
            text: nil,
            lat: 32.985,
            lng: -96.755,
            accuracy: nil,
            people: nil,
            imageCount: 75
        )
        #expect(payload["has_images"]?.boolValue == true)
        #expect(payload["image_count"]?.intValue == 50)
    }

    @Test func omitsImageCountWhenNilOrZero() {
        let payloadNil = MeshPayload.sos(
            category: .safe,
            text: "All fine",
            lat: 32.985,
            lng: -96.755,
            accuracy: nil,
            people: nil,
            imageCount: nil
        )
        #expect(payloadNil["has_images"] == nil)
        #expect(payloadNil["image_count"] == nil)

        let payloadZero = MeshPayload.sos(
            category: .safe,
            text: "All fine",
            lat: 32.985,
            lng: -96.755,
            accuracy: nil,
            people: nil,
            imageCount: 0
        )
        #expect(payloadZero["has_images"] == nil)
        #expect(payloadZero["image_count"] == nil)
    }
}

@Suite struct ProfileUnsavedChangesTests {
    @Test func draftEqualityDetectsUnsavedChanges() {
        var profile = UserProfile(fullName: "Jane Doe")
        profile.preferredName = "Jane"
        profile.birthYear = 1990
        profile.languages = ["English"]
        profile.phone = "+15551234567"
        profile.appearance.heightCm = 170

        let draft1 = ProfileDraft(profile)
        let draft2 = ProfileDraft(profile)
        #expect(draft1 == draft2)

        var edited = draft1
        edited.fullName = "Jane Smith"
        #expect(edited != draft1)

        var editedPet = draft1
        editedPet.pets.append(ProfileDraft.PetDraft(kind: "Dog", count: "1"))
        #expect(editedPet != draft1)
    }
}
