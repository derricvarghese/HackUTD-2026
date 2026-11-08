package com.beacon.mesh.transport

/**
 * Tracks which BLE connection stands for which phone.
 *
 * BLE addresses are not identities: phones rotate their private addresses, and a phone that is both
 * peripheral and central shows up under several addresses. That used to make one phone appear as
 * two or three "ghost" peers. Each app instance has a persistent UUID instead; this registry keeps
 * exactly one outbound link per UUID.
 *
 * Not thread-safe: use from the transport's single (main) thread.
 */
class PeerRegistry(private val ownId: String) {
    sealed interface Decision {
        /** This link is the one to use for [id]. */
        data class Accept(val id: String) : Decision
        /** We already have a link to this phone under another address: drop this one. */
        data class Duplicate(val id: String, val existingAddress: String) : Decision
        /** The id is our own: we saw ourselves. */
        data object Self : Decision
    }

    private val addressById = LinkedHashMap<String, String>()
    private val idByAddress = HashMap<String, String>()

    /** Number of distinct phones with an accepted outbound link. */
    val count: Int get() = addressById.size

    val ids: List<String> get() = addressById.keys.toList()

    fun identify(address: String, id: String): Decision {
        if (id.equals(ownId, ignoreCase = true)) return Decision.Self
        val existing = addressById[id]
        if (existing != null && existing != address) return Decision.Duplicate(id, existing)
        addressById[id] = address
        idByAddress[address] = id
        return Decision.Accept(id)
    }

    fun addressFor(id: String): String? = addressById[id]

    fun idFor(address: String): String? = idByAddress[address]

    /** Forgets [address]; returns the phone id if that link was the accepted one for it. */
    fun release(address: String): String? {
        val id = idByAddress.remove(address) ?: return null
        if (addressById[id] == address) addressById.remove(id)
        return id
    }

    fun clear() {
        addressById.clear()
        idByAddress.clear()
    }

    companion object {
        /** Fallback identity for peers that do not expose the id characteristic (older builds). */
        fun legacyId(address: String) = "addr:$address"
    }
}
