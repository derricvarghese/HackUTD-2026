package com.beacon.mesh.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/**
 * Canonical JSON used for every Beacon signature (server/src/crypto/canonical.ts, server/docs/crypto.md section 1):
 * object keys sorted by UTF-16 code unit, no whitespace, strings escaped like ECMAScript JSON.stringify,
 * numbers printed like ECMAScript Number-to-string.
 */
object Canonical {
    fun json(v: Any?): String = StringBuilder().also { write(it, v) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null, JSONObject.NULL -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Int, is Long, is Short, is Byte -> sb.append(v.toString())
            is Number -> sb.append(number(v.toDouble()))
            is JSONObject -> {
                val keys = v.keys().asSequence().toList().sorted() // String.compareTo = UTF-16 code unit order
                sb.append('{')
                keys.forEachIndexed { i, k ->
                    if (i > 0) sb.append(',')
                    quote(sb, k)
                    sb.append(':')
                    write(sb, v.opt(k))
                }
                sb.append('}')
            }
            is JSONArray -> {
                sb.append('[')
                for (i in 0 until v.length()) {
                    if (i > 0) sb.append(',')
                    write(sb, v.opt(i))
                }
                sb.append(']')
            }
            is Map<*, *> -> write(sb, JSONObject(v.entries.associate { it.key.toString() to it.value }))
            is List<*> -> write(sb, JSONArray(v))
            else -> throw IllegalArgumentException("canonical json: unsupported ${v.javaClass}")
        }
    }

    /** ECMAScript Number::toString for finite doubles (decimal notation between 1e-6 and 1e21, else exponent form). */
    fun number(d: Double): String {
        require(d.isFinite()) { "canonical json: non-finite number" }
        if (d == 0.0) return "0"
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return d.toLong().toString()
        val bd = BigDecimal(java.lang.Double.toString(d)).stripTrailingZeros()
        val abs = Math.abs(d)
        if (abs >= 1e-6 && abs < 1e21) return bd.toPlainString()
        // exponent form: digits "d.ddde+x"
        val unscaled = bd.unscaledValue().abs().toString()
        val exp = unscaled.length - 1 - bd.scale()
        val mant = if (unscaled.length == 1) unscaled else unscaled[0] + "." + unscaled.substring(1)
        return (if (d < 0) "-" else "") + mant + "e" + (if (exp >= 0) "+" else "-") + Math.abs(exp)
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }
}
