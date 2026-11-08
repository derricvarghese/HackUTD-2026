package com.beacon.mesh.ui

import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.MeshEnvelope
import org.json.JSONObject
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.ui.logic.*
import org.junit.Assert.*
import org.junit.Test

class SosDraftTest {
    @Test fun criticalAndHighNeedHold() {
        assertTrue(SosDraft(Category.TRAPPED).requiresHold)
        assertTrue(SosDraft(Category.INJURED).requiresHold)
        assertTrue(SosDraft(Category.WATER_MEDS).requiresHold)
        assertFalse(SosDraft(Category.SAFE).requiresHold)
        assertFalse(SosDraft(Category.CHECKIN).requiresHold)
    }
    @Test fun noteIsTrimmedAndCapped() {
        assertNull(SosDraft(Category.SAFE, "   ").noteOrNull)
        assertEquals("hi", SosDraft(Category.SAFE, "  hi ").noteOrNull)
        assertEquals(SosDraft.MAX_NOTE, SosDraft(Category.SAFE).withNote("x".repeat(1000)).note.length)
    }
    @Test fun peopleClamped() {
        assertEquals(1, SosDraft(Category.SAFE).withPeople(-3).people)
        assertEquals(SosDraft.MAX_PEOPLE, SosDraft(Category.SAFE).withPeople(1000).people)
    }
}

class PermissionPlanTest {
    private val fine = "android.permission.ACCESS_FINE_LOCATION"
    private val scan = "android.permission.BLUETOOTH_SCAN"
    private val adv = "android.permission.BLUETOOTH_ADVERTISE"
    private val conn = "android.permission.BLUETOOTH_CONNECT"

    @Test fun groupsDependOnSdk() {
        assertTrue(PermissionPlan.permissions(PermGroup.BLUETOOTH, 30).isEmpty())
        assertEquals(3, PermissionPlan.permissions(PermGroup.BLUETOOTH, 31).size)
        assertTrue(PermissionPlan.permissions(PermGroup.NOTIFICATIONS, 32).isEmpty())
        assertEquals(1, PermissionPlan.permissions(PermGroup.NOTIFICATIONS, 33).size)
    }
    @Test fun statusProgression() {
        fun s(granted: Set<String>, asked: Set<String>, rationale: Set<String>) =
            PermissionPlan.status(PermGroup.LOCATION, 34, granted, asked, rationale)
        assertEquals(GroupStatus.NOT_ASKED, s(emptySet(), emptySet(), emptySet()))
        assertEquals(GroupStatus.DENIED, s(emptySet(), setOf(fine), setOf(fine)))
        assertEquals(GroupStatus.DENIED_PERMANENTLY, s(emptySet(), setOf(fine), emptySet()))
        assertEquals(GroupStatus.GRANTED, s(setOf(fine), setOf(fine), emptySet()))
    }
    @Test fun notNeededOnOldSdk() =
        assertEquals(GroupStatus.NOT_NEEDED, PermissionPlan.status(PermGroup.NOTIFICATIONS, 30, emptySet(), emptySet(), emptySet()))

    @Test fun readiness() {
        val all = PermissionPlan.Readiness(true, false, true, false, 34)
        assertTrue(all.canRunMesh)       // Android 12+: location is optional
        assertFalse(all.canGetGps)
        val old = PermissionPlan.Readiness(true, false, true, false, 29)
        assertFalse(old.canRunMesh)      // Android 10: BLE scan needs location
        assertFalse(PermissionPlan.Readiness(true, true, false, true, 34).canRunMesh) // Bluetooth off
        assertFalse(PermissionPlan.Readiness(false, true, true, true, 34).canRunMesh) // no BT permission
        assertTrue(PermissionPlan.Readiness(true, true, true, true, 29).canRunMesh)
    }
}

class MessageUiTest {
    private fun msg(id: String, hop: Int, max: Int, own: Boolean, uploaded: Boolean = false, path: List<String> = emptyList()): StoredMessage {
        val env = MeshEnvelope(
            id, "pub", null, "sos", "critical", max, hop, path, "2099-01-01T00:00:00.000Z", "2026-11-07T16:00:00.000Z",
            JSONObject().put("category", "trapped"), "cipher", "sig",
        )
        val payload = if (own) """{"lat":1.0,"lng":2.0,"accuracy_m":5.0,"category":"trapped","text":"help","people_count":2}""" else null
        return StoredMessage(id, env, 2_000, uploaded, own, null, ownPayload = payload)
    }

    @Test fun statuses() {
        assertEquals(MessageStatus.QUEUED, MessageUi.map(msg("a", 0, 10, true)).status)
        assertEquals(MessageStatus.RELAYED, MessageUi.map(msg("a", 0, 10, true), mapOf("a" to 2)).status)
        assertEquals(MessageStatus.UPLOADING, MessageUi.map(msg("a", 0, 10, true), uploadingIds = setOf("a")).status)
        assertEquals(MessageStatus.DELIVERED, MessageUi.map(msg("a", 0, 10, true, uploaded = true)).status)
        assertEquals(MessageStatus.RELAYING, MessageUi.map(msg("a", 1, 10, false, path = listOf("a1b7"))).status)
        assertEquals(MessageStatus.HELD, MessageUi.map(msg("a", 2, 2, false, path = listOf("a1", "b7"))).status)
    }

    @Test fun routeAndFields() {
        val item = MessageUi.map(msg("abcdefghij", 2, 10, false, path = listOf("a1b7", "c3d4")))
        assertEquals(listOf("A1B7", "C3D4"), MessageUi.route(item))
        assertEquals("abcdefgh", item.shortId)
        assertEquals(Category.TRAPPED, item.category)
        assertNull("relays cannot read the encrypted payload", item.people)
        assertTrue(item.critical)
        val own = MessageUi.map(msg("abcdefghij", 0, 10, true))
        assertEquals(2, own.people)
        assertEquals("help", own.text)
    }

    @Test fun contractStatusesFromTheBackend() {
        fun withRemote(status: String?, reached: Boolean = true, eta: Int? = null) =
            msg("a", 0, 10, true).copy(remote = com.beacon.mesh.store.RemoteStatus(status, reached, eta, "Help is on the way, ETA 40 min", 5))
        assertEquals(MessageStatus.DELIVERED, MessageUi.map(withRemote("reported")).status)
        assertEquals(MessageStatus.ASSIGNED, MessageUi.map(withRemote("assigned")).status)
        val en = MessageUi.map(withRemote("en_route", eta = 40))
        assertEquals(MessageStatus.EN_ROUTE, en.status)
        assertEquals(40, en.etaMinutes)
        assertEquals("Help is on the way, ETA 40 min", en.statusMessage)
        assertEquals(MessageStatus.ON_SCENE, MessageUi.map(withRemote("on_scene")).status)
        assertEquals(MessageStatus.RESOLVED, MessageUi.map(withRemote("resolved")).status)
        val rej = MessageUi.map(msg("a", 0, 10, true).copy(rejectReason = "bad_signature"))
        assertEquals(MessageStatus.REJECTED, rej.status)
        assertEquals(0, MessageUi.heldOffline(listOf(rej)))
    }

    @Test fun ageBuckets() {
        assertEquals(Age(0, AgeUnit.NOW), MessageUi.age(0, 30_000))
        assertEquals(Age(5, AgeUnit.MINUTES), MessageUi.age(0, 5 * 60_000L + 1))
        assertEquals(Age(3, AgeUnit.HOURS), MessageUi.age(0, 3 * 3_600_000L))
        assertEquals(Age(2, AgeUnit.DAYS), MessageUi.age(0, 2 * 86_400_000L))
        assertEquals(Age(0, AgeUnit.NOW), MessageUi.age(10_000, 0)) // clock skew
    }

    @Test fun filtersAndHeldCount() {
        val items = listOf(
            MessageUi.map(msg("a", 0, 10, true)),
            MessageUi.map(msg("b", 1, 10, false, uploaded = true, path = listOf("x"))),
            MessageUi.map(msg("c", 1, 10, false, path = listOf("x"))),
        )
        assertEquals(1, MessageUi.filter(items, MessageUi.Filter.MINE).size)
        assertEquals(2, MessageUi.filter(items, MessageUi.Filter.RECEIVED).size)
        assertEquals(2, MessageUi.filter(items, MessageUi.Filter.HELD).size)
        assertEquals(2, MessageUi.heldOffline(items))
    }
}
