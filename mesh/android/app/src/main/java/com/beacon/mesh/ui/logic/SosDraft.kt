package com.beacon.mesh.ui.logic

import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.Priority

/** What the user is composing in the SOS confirmation sheet. Survives rotation and process death. */
data class SosDraft(
    val category: Category,
    val note: String = "",
    val people: Int = 1,
) {
    /** Text sent over the air: trimmed, null when empty. */
    val noteOrNull: String? get() = note.trim().takeIf { it.isNotEmpty() }

    fun withNote(value: String) = copy(note = value.take(MAX_NOTE))
    fun withPeople(value: Int) = copy(people = value.coerceIn(1, MAX_PEOPLE))

    /** Critical and high alerts need a deliberate hold to avoid pocket sends; "safe" and check-ins do not. */
    val requiresHold: Boolean get() = category.priority == Priority.CRITICAL || category.priority == Priority.HIGH

    companion object {
        const val MAX_NOTE = 280
        const val MAX_PEOPLE = 99
        const val HOLD_MILLIS = 1500L
    }
}
