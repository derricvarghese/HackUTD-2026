package com.beacon.mesh.ui.logic

/** Permission groups the onboarding asks for. Pure logic so it can be unit-tested on the JVM. */
enum class PermGroup { BLUETOOTH, LOCATION, NOTIFICATIONS }

enum class GroupStatus { NOT_NEEDED, GRANTED, NOT_ASKED, DENIED, DENIED_PERMANENTLY }

object PermissionPlan {
    private const val BT_SCAN = "android.permission.BLUETOOTH_SCAN"
    private const val BT_ADVERTISE = "android.permission.BLUETOOTH_ADVERTISE"
    private const val BT_CONNECT = "android.permission.BLUETOOTH_CONNECT"
    private const val FINE = "android.permission.ACCESS_FINE_LOCATION"
    private const val COARSE = "android.permission.ACCESS_COARSE_LOCATION"
    private const val NOTIFS = "android.permission.POST_NOTIFICATIONS"

    /** Runtime permissions in a group for the given SDK level (empty = nothing to ask). */
    fun permissions(group: PermGroup, sdk: Int): List<String> = when (group) {
        PermGroup.BLUETOOTH -> if (sdk >= 31) listOf(BT_SCAN, BT_ADVERTISE, BT_CONNECT) else emptyList()
        PermGroup.LOCATION -> listOf(FINE, COARSE)
        PermGroup.NOTIFICATIONS -> if (sdk >= 33) listOf(NOTIFS) else emptyList()
    }

    /**
     * @param granted permissions currently granted
     * @param askedBefore permissions we already requested once (persisted)
     * @param rationale permissions for which the system says to show a rationale
     */
    fun status(
        group: PermGroup,
        sdk: Int,
        granted: Set<String>,
        askedBefore: Set<String>,
        rationale: Set<String>,
    ): GroupStatus {
        val needed = permissions(group, sdk)
        if (needed.isEmpty()) return GroupStatus.NOT_NEEDED
        // Location: fine OR coarse is good enough for the group, but we want precise for SOS.
        val ok = if (group == PermGroup.LOCATION) FINE in granted else needed.all { it in granted }
        if (ok) return GroupStatus.GRANTED
        val missing = needed.filter { it !in granted }
        if (missing.none { it in askedBefore }) return GroupStatus.NOT_ASKED
        // Asked before, not granted, and the system no longer shows the dialog -> permanent denial.
        return if (missing.none { it in rationale }) GroupStatus.DENIED_PERMANENTLY else GroupStatus.DENIED
    }

    /** Everything that must be true before the mesh may start. */
    data class Readiness(
        val bluetoothPermission: Boolean,
        val locationPermission: Boolean,
        val bluetoothOn: Boolean,
        val locationOn: Boolean,
        val sdk: Int,
    ) {
        /** Android 11 and lower require location permission + services to scan for BLE. */
        private val locationRequiredForBle get() = sdk < 31
        val canRunMesh: Boolean
            get() = bluetoothPermission && bluetoothOn &&
                (!locationRequiredForBle || (locationPermission && locationOn))
        /** GPS on the SOS needs both; optional on 12+. */
        val canGetGps: Boolean get() = locationPermission && locationOn
    }
}
