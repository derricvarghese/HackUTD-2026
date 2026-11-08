package com.beacon.mesh.welfare

import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.InMemoryMessageStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val T0 = 1_794_000_000_000L
private const val CID = "0192a7f0-0000-7000-8000-0000000000c1"
private const val SOS = "0192a7d4-1c2e-7000-8a00-0000000000a1"

class FakeClock(var now: Long = T0)

class FakeNotifier : WelfareNotifier {
    val shown = ArrayList<String>()
    /** Notification state per check-in id: ONE entry per id however often it is re-posted (never stacked). */
    val live = LinkedHashMap<String, CheckinPrompt>()
    val alerts = ArrayList<Pair<String, Boolean>>()
    val overdueTexts = ArrayList<String>()
    val cancelled = ArrayList<String>()
    override fun show(p: CheckinPrompt, nowMs: Long, alert: Boolean) {
        shown.add(p.checkinId); live[p.checkinId] = p; alerts.add(p.checkinId to alert)
        if (p.isOverdue(nowMs)) overdueTexts.add(p.checkinId)
    }
    override fun cancel(checkinId: String) { cancelled.add(checkinId); live.remove(checkinId) }
}

private fun restJson(
    id: String = CID, sent: Long = T0, deadline: Long = T0 + 300_000,
    extra: JSONObject.() -> Unit = {},
) = JSONObject()
    .put("id", id).put("sos_id", SOS).put("kind", "welfare").put("channel", "app")
    .put("sent_at", Iso.format(sent)).put("responded_at", JSONObject.NULL).put("response", JSONObject.NULL)
    .put("choices", JSONArray(WelfareResponse.ALL)).put("attempt", 1).put("missed", false)
    .put("alarm_at", Iso.format(deadline - 60_000)).put("deadline_at", Iso.format(deadline)).apply(extra)

class CheckinParsingTest {
    @Test fun parsesAPendingCheckinsArrayFromTheHeartbeatResponse() {
        val body = JSONObject().put("event_active", false).put("pending_checkins", JSONArray().put(restJson()).put(restJson("0192a7f0-0000-7000-8000-0000000000c2", deadline = T0 + 600_000)))
        val list = CheckinParser.fromRestArray(body.getJSONArray("pending_checkins"), T0)
        assertEquals(2, list.size)
        val p = list[0]
        assertEquals(CID, p.checkinId); assertEquals(SOS, p.sosId)
        assertEquals(T0 + 300_000, p.deadlineAtMs) // a stray alarm_at is ignored
        assertEquals(WelfareResponse.ALL, p.choices)
        assertNull(p.response)
    }

    @Test fun overdueCheckinsAreKeptAndAnsweredOnesIgnored() {
        val overdue = CheckinParser.fromRest(restJson { put("missed", true); put("overdue", true); put("reminder_count", 2) }, T0 + 400_000)!!
        assertEquals(2, overdue.reminderCount); assertTrue(overdue.isOverdue(T0 + 400_000))
        assertNull(CheckinParser.fromRest(restJson { put("responded_at", Iso.format(T0)) }, T0))
        assertNull(CheckinParser.fromRest(restJson { put("kind", "other") }, T0))
    }

    @Test fun missingTimesFallBackToTheDefaultWindow() {
        val o = JSONObject().put("id", CID).put("sos_id", SOS).put("sent_at", Iso.format(T0)).put("channel", "app")
        val p = CheckinParser.fromRest(o, T0)!!
        assertEquals(T0 + 300_000, p.deadlineAtMs)
        assertEquals(WelfareResponse.ALL, p.choices)
    }

    @Test fun unknownChoicesAreDroppedAndOrderIsCanonical() {
        val p = CheckinParser.fromRest(restJson { put("choices", JSONArray(listOf("need_urgent_help", "bogus", "still_here"))) }, T0)!!
        assertEquals(listOf("still_here", "need_urgent_help"), p.choices)
    }

    @Test fun parsesAMeshCheckinRequest() {
        val body = JSONObject().put("title", "Are you OK?").put("message", "Please answer").put("attempt", 2).put("tier", "critical").put("reminder", 3)
            .put("choices", JSONArray(WelfareResponse.ALL)).put("deadline_at", Iso.format(T0 + 300_000))
        val bm = BackendMessage("m1", "checkin_request", SOS, CID, body, 5, 0, emptyList(), Iso.format(T0 + 3_600_000), Iso.format(T0), "sig")
        val p = CheckinParser.fromBackend(bm, T0)!!
        assertEquals("Are you OK?", p.title); assertEquals("Please answer", p.message)
        assertEquals(2, p.attempt); assertEquals("critical", p.tier); assertEquals(3, p.reminderCount)
        assertNull(CheckinParser.fromBackend(bm.copy(checkinId = null), T0))
    }
}

class WelfareManagerTest {
    private val clock = FakeClock()
    private val store = InMemoryMessageStore()
    private val notifier = FakeNotifier()
    private fun manager(s: InMemoryMessageStore = store) = WelfareManager(s, notifier, { clock.now })
    private fun prompt(id: String = CID, deadline: Long = T0 + 300_000) =
        CheckinParser.fromRest(restJson(id, deadline = deadline), clock.now)!!

    @Test fun dedupesByCheckinIdAcrossChannels() {
        val m = manager()
        assertEquals(1, m.ingest(listOf(prompt())))
        assertEquals(0, m.ingest(listOf(prompt()))) // heartbeat response again
        assertEquals(0, m.ingest(listOf(prompt().copy(message = "from the mesh"))))
        assertEquals(1, m.all().size)
        assertEquals(listOf(CID), notifier.shown)
    }

    @Test fun answeredAndDayOldCheckinsAreIgnored() {
        val m = manager()
        clock.now = T0 + 400_000
        assertEquals(0, m.ingest(listOf(prompt().copy(deadlineAtMs = clock.now + 10_000, response = "still_here"))))
        clock.now = T0 + 300_000 + CheckinPrompt.STALE_AFTER_DEADLINE_MS
        assertEquals(0, m.ingest(listOf(prompt(deadline = T0 + 300_000))))
        assertTrue(m.all().isEmpty())
    }

    @Test fun answeredCheckinStaysAnsweredAndIsNotRevivedByADuplicate() {
        val m = manager()
        m.ingest(listOf(prompt()))
        m.answer(CID, WelfareResponse.STILL_HERE)
        assertEquals(0, m.ingest(listOf(prompt())))
        assertTrue(m.pending().isEmpty())
    }

    @Test fun persistsAcrossARestart() {
        manager().ingest(listOf(prompt()))
        val restarted = manager() // new process, same database
        assertEquals(listOf(CID), restarted.pending().map { it.checkinId })
        assertEquals(0, restarted.ingest(listOf(prompt())))
    }

    @Test fun answeringRemovesTheNotification() {
        val m = manager()
        m.ingest(listOf(prompt()))
        val done = m.answer(CID, WelfareResponse.NEED_URGENT_HELP)!!
        assertEquals(WelfareResponse.NEED_URGENT_HELP, done.response)
        assertTrue(CID in notifier.cancelled)
        assertNull(m.answer(CID, WelfareResponse.STILL_HERE)) // second answer ignored
    }

    @Test fun restoreAfterRebootRepostsOpenCheckinsAndSkipsAnswered() {
        val m = manager()
        m.ingest(listOf(prompt(), prompt("c2"), prompt("c3")))
        m.answer("c3", WelfareResponse.STILL_HERE)
        notifier.shown.clear()
        clock.now = T0 + 120_000 // device was off for a while
        assertEquals(2, manager().restore())
        assertEquals(listOf(CID, "c2"), notifier.shown)
        assertTrue(notifier.alerts.takeLast(2).none { it.second }) // re-posting after a reboot does not beep again
    }

    @Test fun resolvedCaseAndCancelAllClearEverything() {
        val m = manager()
        m.ingest(listOf(prompt(), prompt("c2")))
        m.cancelForSos(SOS)
        assertTrue(m.pending().isEmpty())
        m.ingest(listOf(prompt("c9")))
        m.cancelAll()
        assertTrue(m.pending().isEmpty())
    }

    @Test fun reconcileClearsCheckinsTheServerNoLongerListsAfterTheGracePeriod() {
        val m = manager()
        m.ingest(listOf(prompt()))
        m.reconcile(emptySet()) // just arrived: a racing poll must not clear it
        assertEquals(1, m.pending().size)
        clock.now += WelfareManager.RECONCILE_GRACE_MS + 1
        m.reconcile(emptySet())
        assertTrue(m.pending().isEmpty())
    }

    @Test fun testCheckinIsLocalOnly() {
        val m = manager()
        val t = WelfareManager.testPrompt(clock.now)
        assertEquals(1, m.ingest(listOf(t)))
        assertEquals(clock.now + 20_000, t.deadlineAtMs)
        m.reconcile(emptySet()); clock.now += 60_000
        assertTrue(m.dueReplies().isEmpty())
    }
}

class WelfareReminderTest {
    private val clock = FakeClock()
    private val store = InMemoryMessageStore()
    private val notifier = FakeNotifier()
    private val manager = WelfareManager(store, notifier, { clock.now }, reminderIntervalMs = { 300_000 })
    private fun delivery(reminder: Int = 0) = CheckinParser.fromRest(restJson { put("reminder_count", reminder) }, clock.now)!!
    private fun meshReminder(reminder: Int, msgId: String): CheckinPrompt {
        val body = JSONObject().put("title", "Are you OK?").put("reminder", reminder).put("deadline_at", Iso.format(T0 + 300_000))
        return CheckinParser.fromBackend(BackendMessage(msgId, "checkin_request", SOS, CID, body, 5, 0, emptyList(), Iso.format(clock.now + 3_600_000), Iso.format(clock.now), "s"), clock.now)!!
    }

    @Test fun aReminderOfTheSameCheckinUpdatesTheNotificationInPlaceAndAlertsAgain() {
        assertEquals(1, manager.ingest(listOf(delivery())))
        clock.now = T0 + 320_000 // past the deadline: the server re-delivers the SAME checkin_id (new BackendMessage id)
        assertEquals(0, manager.ingest(listOf(meshReminder(1, "bm-2"))))
        clock.now += 20_000
        assertEquals(0, manager.ingest(listOf(meshReminder(2, "bm-3"))))
        assertEquals(1, manager.all().size)               // never a second prompt
        assertEquals(setOf(CID), notifier.live.keys)      // one notification, same id
        assertEquals(listOf(true, true, true), notifier.alerts.map { it.second })
        assertEquals(2, manager.find(CID)!!.reminderCount)
        assertEquals(WelfareNotificationModel.idFor(CID), WelfareNotificationModel.build(manager.find(CID)!!, clock.now)!!.notificationId)
    }

    @Test fun restPollsDoNotReAlertEveryTimeButTheSameDeliveryIsNotDropped() {
        manager.ingest(listOf(delivery()))
        clock.now = T0 + 301_000
        manager.tickReminders() // first overdue alert at the deadline
        val before = notifier.alerts.size
        clock.now += 30_000
        manager.ingest(listOf(delivery(0))) // 30 s poll returns the same overdue check-in again
        assertEquals(before, notifier.alerts.size) // nothing new to say: no extra sound, no duplicate
        assertEquals(1, notifier.live.size)
    }

    @Test fun notificationSwitchesToOverdueTextAfterTheDeadlineAndKeepsRepeatingLocally() {
        manager.ingest(listOf(delivery()))
        val pre = WelfareNotificationModel.build(manager.find(CID)!!, T0 + 100_000)!!
        assertFalse(pre.overdue); assertEquals(T0 + 300_000, pre.deadlineAtMs)
        clock.now = T0 + 299_000
        manager.tickReminders(); assertTrue(notifier.overdueTexts.isEmpty()) // not yet overdue
        clock.now = T0 + 301_000
        manager.tickReminders() // transition: overdue wording, alert once
        assertEquals(listOf(CID), notifier.overdueTexts)
        val post = WelfareNotificationModel.build(manager.find(CID)!!, clock.now)!!
        assertTrue(post.overdue); assertNull(post.deadlineAtMs) // no countdown; no timeout field exists, so it is never auto-cancelled
        assertEquals(WelfareResponse.ALL, post.actions)
        // local cadence: nothing before the interval, one alert at each interval, no server message needed
        val n = notifier.alerts.size
        clock.now += 299_000; manager.tickReminders()
        assertEquals(n, notifier.alerts.size)
        clock.now += 2_000; manager.tickReminders()
        assertEquals(n + 1, notifier.alerts.size)
        clock.now += 300_000; manager.tickReminders()
        assertEquals(n + 2, notifier.alerts.size)
        assertEquals(1, notifier.live.size)
    }

    @Test fun answeringAnOverdueCheckinIsAcceptedAndStopsTheReminders() {
        manager.ingest(listOf(delivery()))
        clock.now = T0 + 900_000
        manager.tickReminders()
        val done = manager.answer(CID, WelfareResponse.STILL_HERE)!!
        assertEquals(WelfareResponse.STILL_HERE, done.response)
        assertTrue(notifier.live.isEmpty())
        val n = notifier.alerts.size
        clock.now += 600_000; manager.tickReminders()
        manager.ingest(listOf(delivery(5))) // a late reminder still in flight is ignored
        assertEquals(n, notifier.alerts.size)
        assertEquals(listOf(CID), manager.dueReplies().map { it.checkinId }) // the late answer is still sent (server accepts it)
    }

    @Test fun overdueStateSurvivesARestartWithoutDuplicates() {
        manager.ingest(listOf(delivery()))
        clock.now = T0 + 400_000
        manager.tickReminders()
        val restarted = WelfareManager(store, notifier, { clock.now }, reminderIntervalMs = { 300_000 })
        assertEquals(0, restarted.ingest(listOf(delivery(1)))) // reminder after restart: update, not a new prompt
        assertEquals(1, restarted.all().size)
        assertEquals(1, restarted.restore())
    }
}

class WelfareNotificationModelTest {
    @Test fun buildsTitleBodyActionsAndTimeout() {
        val p = CheckinPrompt(CID, SOS, "Please answer", T0 + 300_000, T0, null, title = "Are you OK?", choices = WelfareResponse.ALL, attempt = 1)
        val m = WelfareNotificationModel.build(p, T0 + 60_000)!!
        assertEquals("Are you OK?", m.title); assertEquals("Please answer", m.body)
        assertEquals(WelfareResponse.ALL, m.actions)
        assertEquals(T0 + 300_000, m.deadlineAtMs); assertFalse(m.overdue)
        assertFalse(m.urgent)
        assertEquals(WelfareNotificationModel.idFor(CID), m.notificationId)
    }

    @Test fun serverMessageIsTheTitleWhenThereIsNoTitle() {
        val m = WelfareNotificationModel.build(CheckinPrompt(CID, SOS, "Are you still there?", T0 + 1000, T0, null), T0)!!
        assertEquals("Are you still there?", m.title); assertNull(m.body)
    }

    @Test fun onlyOfferedChoicesBecomeActionsAndEmptyMeansAllThree() {
        val two = CheckinPrompt(CID, SOS, null, T0 + 1000, T0, null, choices = listOf("need_urgent_help", "still_here"))
        assertEquals(listOf("still_here", "need_urgent_help"), WelfareNotificationModel.build(two, T0)!!.actions)
        val none = two.copy(choices = emptyList())
        assertEquals(WelfareResponse.ALL, WelfareNotificationModel.build(none, T0)!!.actions)
    }

    @Test fun noNotificationForAnsweredOrDayOld() {
        val p = CheckinPrompt(CID, SOS, null, T0 + 1000, T0, null)
        assertNull(WelfareNotificationModel.build(p.copy(response = "still_here"), T0))
        assertNull(WelfareNotificationModel.build(p, T0 + 1000 + CheckinPrompt.STALE_AFTER_DEADLINE_MS))
        assertTrue(WelfareNotificationModel.build(p, T0 + 1000)!!.overdue)
        assertTrue(WelfareNotificationModel.build(p.copy(attempt = 2), T0)!!.urgent)
    }
}

class WelfareReplierTest {
    private val clock = FakeClock()
    private val store = InMemoryMessageStore()
    private val manager = WelfareManager(store, FakeNotifier(), { clock.now })
    private val meshSent = ArrayList<Pair<String, String>>()
    private var meshOk = true
    private val replier = WelfareReplier(manager, MeshReplySender { p, r -> meshSent.add(p.checkinId to r); meshOk }, { clock.now })

    private fun answered(response: String = WelfareResponse.STILL_HERE): CheckinPrompt {
        manager.ingest(listOf(CheckinParser.fromRest(restJson(), clock.now)!!))
        return manager.answer(CID, response)!!
    }
    private fun fail(code: Int?, retry: Int? = null) = ApiResult.Failure(code, null, "x", retry)

    @Test fun onlineSuccessMarksDelivered() {
        val p = answered()
        assertEquals(DeliveryOutcome.DELIVERED, replier.apply(p, true, ApiResult.Ok(Unit, 200)))
        assertTrue(manager.find(CID)!!.delivered)
        assertTrue(meshSent.isEmpty())
        assertTrue(manager.dueReplies().isEmpty())
    }

    @Test fun offlineSendsAMeshReplyOnceWithTheResponse() {
        val p = answered(WelfareResponse.NEED_URGENT_HELP)
        assertEquals(DeliveryOutcome.MESH_SENT, replier.apply(p, false, null))
        assertEquals(listOf(CID to "need_urgent_help"), meshSent)
        replier.apply(manager.find(CID)!!, false, null)
        assertEquals(1, meshSent.size)
        assertTrue(manager.find(CID)!!.meshReplied)
        assertFalse(manager.find(CID)!!.delivered) // still PATCHed once online
    }

    @Test fun conflictAndNotFoundClearLocally() {
        for (code in listOf(409, 404)) {
            val p = answered()
            assertEquals(DeliveryOutcome.CLEARED, replier.apply(p, true, fail(code)))
            assertTrue(manager.find(CID)!!.delivered)
            store.deletePrompt(CID)
        }
    }

    @Test fun otherClientErrorsAreFinalButRateLimitAndNetworkRetry() {
        var p = answered()
        assertEquals(DeliveryOutcome.REJECTED, replier.apply(p, true, fail(422)))
        store.deletePrompt(CID)
        p = answered()
        assertEquals(DeliveryOutcome.RETRY_LATER, replier.apply(p, true, fail(null)))
        assertFalse(manager.find(CID)!!.delivered)
        store.deletePrompt(CID)
        p = answered()
        assertEquals(DeliveryOutcome.RETRY_LATER, replier.apply(p, true, fail(503)))
    }

    @Test fun networkFailureBacksOffAndFallsBackToMesh() {
        val p = answered()
        replier.apply(p, true, fail(null))
        val s1 = manager.find(CID)!!
        assertEquals(1, s1.replyAttempts); assertTrue(s1.meshReplied)
        assertEquals(clock.now + ReplyBackoff.delayMs(1), s1.nextReplyAtMs)
        assertTrue(manager.dueReplies().isEmpty()) // backoff not elapsed
        clock.now = s1.nextReplyAtMs
        assertEquals(listOf(CID), manager.dueReplies().map { it.checkinId })
        replier.apply(manager.find(CID)!!, true, fail(null))
        assertEquals(2, manager.find(CID)!!.replyAttempts)
        assertTrue(manager.find(CID)!!.nextReplyAtMs - clock.now >= ReplyBackoff.delayMs(2))
        clock.now = T0 + 300_000 // deadline passed: a late answer is still accepted, so retries continue
        assertEquals(listOf(CID), manager.dueReplies().map { it.checkinId })
        clock.now = T0 + 300_000 + CheckinPrompt.STALE_AFTER_DEADLINE_MS // a day later: give up
        assertTrue(manager.dueReplies().isEmpty())
        assertEquals(1, meshSent.size)
    }

    @Test fun backoffGrowsAndHonoursRetryAfter() {
        assertEquals(10_000, ReplyBackoff.delayMs(1)); assertEquals(20_000, ReplyBackoff.delayMs(2))
        assertEquals(120_000, ReplyBackoff.delayMs(9))
        assertEquals(90_000, ReplyBackoff.delayMs(1, retryAfterSeconds = 90))
    }

    @Test fun testCheckinNeverTouchesTheNetwork() {
        val t = WelfareManager.testPrompt(clock.now)
        manager.ingest(listOf(t))
        val done = manager.answer(t.checkinId, WelfareResponse.STILL_HERE)!!
        assertEquals(DeliveryOutcome.LOCAL_ONLY, replier.apply(done, true, ApiResult.Ok(Unit, 200)))
        assertTrue(meshSent.isEmpty())
    }
}

class WelfareStateAndCountdownTest {
    private fun p(resp: String?, at: Long = T0, deadline: Long = T0 + 300_000) =
        CheckinPrompt(CID + resp, SOS, null, deadline, T0, resp, answeredAtMs = if (resp == null) null else at)

    @Test fun dueThenWhatThePersonSaid() {
        assertEquals(WelfareState.Due(T0 + 300_000), WelfareState.of(SOS, listOf(p(null)), T0))
        assertEquals(WelfareState.StillHere, WelfareState.of(SOS, listOf(p("still_here")), T0))
        assertEquals(WelfareState.UrgentHelp, WelfareState.of(SOS, listOf(p("still_here", 1), p("need_urgent_help", 2)), T0))
        assertEquals(WelfareState.ResolvedByYou, WelfareState.of(SOS, listOf(p("no_longer_need_help")), T0))
        assertNull(WelfareState.of(SOS, listOf(p("server_cleared")), T0))
        assertNull(WelfareState.of("other", listOf(p(null)), T0))
        assertEquals(WelfareState.Overdue, WelfareState.of(SOS, listOf(p(null)), T0 + 400_000)) // overdue stays active
    }

    @Test fun countdownFormat() {
        assertEquals("05:00", Countdown.format(300_000)); assertEquals("00:01", Countdown.format(1)); assertEquals("00:00", Countdown.format(-5))
        assertEquals("75:00", Countdown.format(75 * 60_000L))
    }
}
