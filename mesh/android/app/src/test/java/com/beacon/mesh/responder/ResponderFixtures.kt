package com.beacon.mesh.responder

import com.beacon.mesh.net.HttpResponse
import com.beacon.mesh.support.FakeHttp

/** JSON builders shared by the responder tests. Values are synthetic. */
object RF {
    fun tokens(access: String = "acc1", refresh: String = "ref1", role: String = "responder", expires: Int = 900) =
        """{"access_token":"$access","refresh_token":"$refresh","token_type":"Bearer","expires_in":$expires,
           "responder":{"id":"r-1","username":"ana","name":"Ana","role":"$role","extra_new_field":1}}"""

    fun sos(
        id: String, score: Int = 50, status: String = "reported", category: String = "trapped", silent: Boolean = false,
        exact: Boolean = false, assignee: String? = null, assignmentStatus: String = "assigned", updated: String = "2026-11-07T16:00:00Z",
        contact: String = "connected", name: String? = "Maria Gonzalez",
    ) = """{"id":"$id","sender_hash":"ab","channel":"mesh","category":"$category","status":"$status","score":$score,
        "confidence":"high","approx_location":{"lat":32.995,"lng":-96.755,"radius_m":1000},
        "location":${if (exact) """{"lat":32.9912,"lng":-96.7511}""" else "null"},
        "silent":$silent,"contact_state":"$contact","last_heard_at":"2026-11-07T15:59:00Z","updated_at":"$updated",
        "hop":{"hop_count":3,"max_hops":10,"hop_path":["A1","B7","C3"]},"future_field":{"x":[1,2]},
        "assignment":${if (assignee != null) """{"id":"as-$id","responder_id":"$assignee","responder_name":"Other","status":"$assignmentStatus"}""" else "null"},
        "profile":${if (name != null) """{"view":"public","full_name":"$name","preferred_name":"Elena","age_range":"65-79","vulnerability_flags":["elderly","oxygen"],"has_profile":true}""" else "null"}}"""

    fun page(vararg items: String) = """{"data":[${items.joinToString(",")}],"next_cursor":null,"total":${items.size}}"""

    fun FakeHttp.loginOk() = on("POST", "/v1/auth/login") { json(200, tokens()) }
    fun resp(code: Int, body: String = "{}") = HttpResponse(code, body)
}
