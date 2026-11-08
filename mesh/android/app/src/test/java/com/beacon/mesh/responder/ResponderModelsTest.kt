package com.beacon.mesh.responder

import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.store.StoredMessage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponderModelsTest {
    private val me = ResponderAccount("r-1", "ana", "Ana", "responder")
    private fun case(json: String) = ResponderCase.from(JSONObject(json))!!

    @Test fun toneFollowsScoreThresholdsAndSafeCategory() {
        assertEquals(PinTone.CRITICAL, CaseRules.tone("trapped", 70))
        assertEquals(PinTone.HIGH, CaseRules.tone("injured", 69))
        assertEquals(PinTone.HIGH, CaseRules.tone("other", 40))
        assertEquals(PinTone.NORMAL, CaseRules.tone("other", 39))
        assertEquals(PinTone.SAFE, CaseRules.tone("safe", 95))
        assertEquals(PinTone.NORMAL, CaseRules.tone("need_water_meds", 0))
    }

    @Test fun mapRadiusIsSmallForExactAndAtLeast100ForApprox() {
        assertEquals(40.0, CaseRules.mapRadiusM(case(RF.sos("a", exact = true))), 0.0)
        assertEquals(1000.0, CaseRules.mapRadiusM(case(RF.sos("a"))), 0.0)
        val tiny = case(RF.sos("a").replace("\"radius_m\":1000", "\"radius_m\":10"))
        assertEquals(100.0, CaseRules.mapRadiusM(tiny), 0.0)
    }

    @Test fun silentAndUnresponsiveBothPulse() {
        assertTrue(case(RF.sos("a", silent = true)).needsAttention)
        assertTrue(case(RF.sos("a", contact = "unresponsive")).needsAttention)
        assertFalse(case(RF.sos("a", contact = "lost_contact")).needsAttention)
    }

    @Test fun missingApproxLocationDropsTheCaseAndNullExactIsApprox() {
        assertNull(ResponderCase.from(JSONObject("""{"id":"x","status":"reported"}""")))
        val c = case(RF.sos("a"))
        assertFalse(c.hasExactLocation)
    }

    @Test fun mineMeansActiveAssignmentOfThisResponder() {
        assertTrue(case(RF.sos("a", assignee = "r-1")).isMine(me))
        assertFalse(case(RF.sos("a", assignee = "r-1", assignmentStatus = "released")).isMine(me))
        assertFalse(case(RF.sos("a", assignee = "r-1", assignmentStatus = "resolved")).isMine(me))
        assertFalse(case(RF.sos("a", assignee = "r-2")).isMine(me))
        assertTrue(case(RF.sos("a", assignee = "r-2")).claimedByOther(me))
        assertFalse(case(RF.sos("a", assignee = "r-2", assignmentStatus = "released")).claimedByOther(me))
        assertFalse(case(RF.sos("a")).claimedByOther(me))
    }

    @Test fun rankingPutsMineFirstThenScore() {
        val l = CaseRules.ranked(listOf(case(RF.sos("lo", 10)), case(RF.sos("hi", 90)), case(RF.sos("mine", 5, assignee = "r-1"))), me)
        assertEquals(listOf("mine", "hi", "lo"), l.map { it.id })
    }

    @Test fun filters() {
        val all = listOf(
            case(RF.sos("crit", 80)), case(RF.sos("quiet", 30, silent = true)),
            case(RF.sos("mine", 20, status = "assigned", assignee = "r-1")), case(RF.sos("claimed", 20, status = "assigned", assignee = "r-2")),
        )
        fun ids(f: CaseFilter) = CaseRules.applyFilter(all, f, me).map { it.id }
        assertEquals(4, ids(CaseFilter.ALL).size)
        assertEquals(listOf("crit"), ids(CaseFilter.CRITICAL))
        assertEquals(listOf("quiet"), ids(CaseFilter.SILENT))
        assertEquals(listOf("mine"), ids(CaseFilter.MINE))
        assertEquals(listOf("crit", "quiet"), ids(CaseFilter.UNCLAIMED))
    }

    @Test fun mergeReplacesAddsAndDropsFinishedOrMergedCases() {
        val cur = listOf(case(RF.sos("a", 10)), case(RF.sos("b", 20)), case(RF.sos("c", 30))).associateBy { it.id }
        val merged = CaseRules.merge(cur, listOf(
            case(RF.sos("a", 99)), case(RF.sos("b", status = "resolved")), case(RF.sos("d", 5)),
            case(RF.sos("c").replace("\"silent\"", "\"merged_into\":\"a\",\"silent\"")),
        ))
        assertEquals(listOf("a", "d"), merged.keys.toList())
        assertEquals(99, merged.getValue("a").score)
    }

    @Test fun roles() {
        assertFalse(ResponderAccount("v", "v", "V", "volunteer").canAct)
        assertTrue(ResponderAccount("r", "r", "R", "responder").canAct)
        assertTrue(ResponderAccount("a", "a", "A", "admin").canAct)
    }

    private fun env(id: String, kind: String = "sos", expires: Long, routing: String) = MeshEnvelope(
        id, "k", null, kind, "critical", 10, 0, emptyList(), Iso.format(expires), Iso.format(0), JSONObject(routing), "p", "s",
    )
    private fun msg(e: MeshEnvelope, own: Boolean = false) = StoredMessage(e.id, e, 0, false, own, null)

    @Test fun meshTargetsOnlyForLiveForeignSosNotYetOnTheServer() {
        val now = 1_000L
        val ok = """{"approx":{"lat":32.995,"lng":-96.755,"radius_m":1000},"category":"trapped"}"""
        val list = listOf(
            msg(env("m1", expires = 5_000, routing = ok)),
            msg(env("own", expires = 5_000, routing = ok), own = true),
            msg(env("old", expires = 500, routing = ok)),
            msg(env("hb", kind = "heartbeat", expires = 5_000, routing = ok)),
            msg(env("onserver", expires = 5_000, routing = ok)),
            msg(env("noapprox", expires = 5_000, routing = """{"category":"trapped"}""")),
        )
        val t = MapTargets.fromMesh(list, setOf("onserver"), now) { "T:$it" }
        assertEquals(listOf("mesh-m1"), t.map { it.id })
        assertEquals(PinTone.CRITICAL, t[0].tone); assertEquals("T:trapped", t[0].title); assertFalse(t[0].exact)
        assertEquals(MapTarget.Source.MESH, t[0].source)
    }

    @Test fun fromCaseUsesSmallExactCircle() {
        val t = MapTargets.fromCase(case(RF.sos("a", 80, exact = true, assignee = "r-1")), "T", me)
        assertTrue(t.exact); assertTrue(t.mine); assertEquals(40.0, t.radiusM, 0.0); assertEquals(32.9912, t.lat, 1e-9)
    }
}
