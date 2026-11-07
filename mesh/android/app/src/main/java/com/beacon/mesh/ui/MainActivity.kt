package com.beacon.mesh.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.beacon.mesh.MeshNode
import com.beacon.mesh.MeshService
import com.beacon.mesh.protocol.Category

/** Minimal test harness for the mesh: SOS buttons, demo hop cap, message list and log. No AndroidX. */
class MainActivity : Activity() {
    private lateinit var node: MeshNode
    private lateinit var status: TextView
    private lateinit var hopCapLabel: TextView
    private lateinit var messagesView: TextView
    private lateinit var logView: TextView
    private lateinit var note: EditText
    private val onChange: () -> Unit = { runOnUiThread { render() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        node = MeshNode.get(this)
        setContentView(buildUi())
        requestPermissionsIfNeeded()
    }

    override fun onStart() {
        super.onStart()
        node.addListener(onChange)
        render()
    }

    override fun onStop() {
        node.removeListener(onChange)
        super.onStop()
    }

    // ---- Permissions (asked at onboarding, not mid-crisis) ----

    private fun requiredPermissions(): List<String> {
        val p = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) {
            p += Manifest.permission.BLUETOOTH_SCAN
            p += Manifest.permission.BLUETOOTH_ADVERTISE
            p += Manifest.permission.BLUETOOTH_CONNECT
        }
        if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.POST_NOTIFICATIONS
        return p
    }

    private fun requestPermissionsIfNeeded() {
        val missing = requiredPermissions().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) startMesh() else requestPermissions(missing.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // GPS and notifications are optional; the mesh only needs Bluetooth access.
        val needed = if (Build.VERSION.SDK_INT >= 31) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION) // BLE scanning needs location before Android 12
        }
        val bluetoothOk = needed.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        if (bluetoothOk) startMesh() else status.text = "Bluetooth permissions are required for the mesh."
    }

    private fun startMesh() {
        startForegroundService(Intent(this, MeshService::class.java))
        node.start()
        render()
    }

    // ---- UI ----

    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        status = TextView(this).apply { textSize = 16f; setTypeface(typeface, Typeface.BOLD) }
        col.addView(status)

        note = EditText(this).apply { hint = "Optional note (e.g. 2 people, water rising)" }
        col.addView(note)

        fun sosRow(vararg items: Pair<String, Category>) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            items.forEach { (label, cat) ->
                addView(Button(this@MainActivity).apply {
                    text = label
                    textSize = 18f
                    minHeight = pad * 4
                    setTextColor(Color.WHITE)
                    setBackgroundColor(
                        when (cat) {
                            Category.SAFE -> Color.rgb(46, 125, 50)
                            Category.WATER_MEDS -> Color.rgb(239, 108, 0)
                            else -> Color.rgb(198, 40, 40)
                        }
                    )
                    setOnClickListener {
                        node.sendSos(cat, note.text.toString())
                        note.setText("")
                    }
                }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    setMargins(pad / 4, pad / 4, pad / 4, pad / 4)
                })
            }
        }
        col.addView(sosRow("Trapped" to Category.TRAPPED, "Injured" to Category.INJURED))
        col.addView(sosRow("Water / meds" to Category.WATER_MEDS, "I'm safe" to Category.SAFE))
        col.addView(sosRow("Check-in" to Category.CHECKIN))

        col.addView(header("Demo settings"))
        hopCapLabel = TextView(this)
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(Button(this@MainActivity).apply {
                text = "−"
                setOnClickListener { node.demoHopCap = ((node.demoHopCap ?: 0) - 1).takeIf { it > 0 } }
            })
            addView(Button(this@MainActivity).apply {
                text = "+"
                setOnClickListener { node.demoHopCap = minOf((node.demoHopCap ?: 0) + 1, 10) }
            })
            addView(hopCapLabel)
        })
        col.addView(CheckBox(this).apply {
            text = "Force offline (never act as gateway)"
            isChecked = node.forceOffline
            setOnCheckedChangeListener { _, checked -> node.forceOffline = checked }
        })
        val url = EditText(this).apply {
            hint = "Backend URL (http://192.168.x.x:3000)"
            setText(node.backendUrl)
            setSingleLine()
        }
        col.addView(url)
        col.addView(Button(this).apply {
            text = "Save backend URL"
            setOnClickListener { node.backendUrl = url.text.toString() }
        })

        col.addView(header("Messages"))
        messagesView = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 12f }
        col.addView(messagesView)

        col.addView(header("Log"))
        logView = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 10f }
        col.addView(logView)

        return ScrollView(this).apply { addView(col) }
    }

    private fun header(text: String) = TextView(this).apply {
        this.text = text
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, (20 * resources.displayMetrics.density).toInt(), 0, 0)
    }

    private fun render() {
        val role = if (node.isGateway) "GATEWAY (online)" else "Offline relay"
        status.text = "Relay ${node.relayId} · ${node.peerCount} peer(s) · $role"
        hopCapLabel.text = node.demoHopCap?.let { "  Non-critical max hops: $it" } ?: "  Hop cap: off (priority table)"
        messagesView.text = node.messages.joinToString("\n\n") { m ->
            val e = m.envelope
            val route = if (e.path.isEmpty()) "origin" else e.path.joinToString(" → ")
            val state = if (m.canForward) "relaying" else "hop limit reached"
            buildString {
                append("${m.header.body?.category ?: m.header.kind}  ${m.header.pri.uppercase()}")
                if (m.isOwn) append("  (mine)")
                if (m.uploaded) append("  ✓ uploaded")
                m.header.body?.text?.let { append("\n  $it") }
                append("\n  hop ${e.hop}/${m.header.maxHops} · $route · $state")
            }
        }.ifEmpty { "No messages yet." }
        logView.text = node.logLines.take(80).joinToString("\n")
    }
}
