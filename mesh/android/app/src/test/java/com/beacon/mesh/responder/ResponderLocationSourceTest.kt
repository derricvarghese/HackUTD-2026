package com.beacon.mesh.responder

import android.Manifest
import android.app.Application
import android.content.Context
import android.location.Location
import android.location.LocationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResponderLocationSourceTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @Test
    fun startWithoutPermissionReturnsFalse() {
        val shadowApp = shadowOf(app)
        shadowApp.denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        val source = ResponderLocationSource(app)
        var called = false
        val ok = source.start { _, _ -> called = true }
        assertFalse(ok)
        assertFalse(called)
    }

    @Test
    @Suppress("DEPRECATION")
    fun startWithPermissionAndLastKnownImmediatelyEmitsFix() {
        val shadowApp = shadowOf(app)
        shadowApp.grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

        val shadowLm = shadowOf(lm)
        shadowLm.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
        val fix = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 32.985
            longitude = -96.750
            accuracy = 8.0f
            time = System.currentTimeMillis()
        }
        shadowLm.setLastKnownLocation(LocationManager.GPS_PROVIDER, fix)

        val source = ResponderLocationSource(app)
        val fixes = mutableListOf<Pair<Double, Double>>()
        val ok = source.start { lat, lng -> fixes.add(lat to lng) }

        assertTrue(ok)
        assertEquals(1, fixes.size)
        assertEquals(32.985, fixes[0].first, 0.0001)
        assertEquals(-96.750, fixes[0].second, 0.0001)
        source.stop()
    }

    @Test
    @Suppress("DEPRECATION")
    fun subsequentLocationUpdateTriggersOffer() {
        val shadowApp = shadowOf(app)
        shadowApp.grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

        val shadowLm = shadowOf(lm)
        shadowLm.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
        val fix1 = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 32.985
            longitude = -96.750
            accuracy = 8.0f
            time = 1_000_000L
        }
        shadowLm.setLastKnownLocation(LocationManager.GPS_PROVIDER, fix1)

        val source = ResponderLocationSource(app)
        val fixes = mutableListOf<Pair<Double, Double>>()
        val ok = source.start { lat, lng -> fixes.add(lat to lng) }
        assertTrue(ok)
        assertEquals(1, fixes.size)

        // Subsequent update from GPS provider
        val fix2 = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = 32.986
            longitude = -96.751
            accuracy = 4.0f
            time = 1_010_000L
        }
        shadowLm.simulateLocation(fix2)
        shadowOf(android.os.Looper.getMainLooper()).idle()

        assertEquals(2, fixes.size)
        assertEquals(32.986, fixes[1].first, 0.0001)
        assertEquals(-96.751, fixes[1].second, 0.0001)
        source.stop()
    }
}
