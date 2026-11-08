package com.beacon.mesh.responder

import android.app.Application
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import com.beacon.mesh.ui.responder.ResponderViewModel
import com.beacon.mesh.ui.responder.ShareNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResponderViewModelTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun sharePreferenceDefaultsToTrue() {
        app.getSharedPreferences("beacon_responder_prefs", Application.MODE_PRIVATE).edit().clear().commit()
        val vm = ResponderViewModel(app, SavedStateHandle())
        idle()
        assertTrue("KEY_SHARE must default to true", vm.share.value.wanted)
    }

    @Test
    fun enableAndDisableSharingUpdatesPreferencesAndState() {
        val vm = ResponderViewModel(app, SavedStateHandle())
        idle()
        vm.enableSharing(fine = true)
        idle()
        assertTrue(vm.share.value.wanted)
        assertFalse(vm.share.value.approximate)

        vm.enableSharing(fine = false)
        idle()
        assertTrue(vm.share.value.wanted)
        assertTrue(vm.share.value.approximate)

        vm.disableSharing()
        idle()
        assertFalse(vm.share.value.wanted)
        assertFalse(vm.share.value.active)
    }

    @Test
    fun requestLocationPermissionIncrementsTrigger() {
        val vm = ResponderViewModel(app, SavedStateHandle())
        val initial = vm.requestPermissionTrigger.value
        vm.requestLocationPermission()
        assertEquals(initial + 1, vm.requestPermissionTrigger.value)
    }

    @Test
    fun onPermissionRevokedCleansNoticeAndArming() {
        val vm = ResponderViewModel(app, SavedStateHandle())
        vm.enableSharing(fine = true)
        idle()

        // Revoking permission should set notice and stop armed state
        vm.onPermissionState(fine = false, coarse = false)
        idle()
        assertFalse(vm.share.value.active)

        // Clear notice
        vm.clearShareNotice()
        assertNull(vm.shareNotice.value)
    }

    @Test
    fun deactivatingViaSetActiveStopsSharing() {
        val vm = ResponderViewModel(app, SavedStateHandle())
        vm.enableSharing(fine = true)
        idle()

        vm.setActive(false)
        idle()
        assertFalse(vm.share.value.active)
    }
}
