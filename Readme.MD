Beacon: disaster response with offline peer-to-peer messaging

One-liner: When a disaster takes out cell service, Beacon lets phones pass SOS messages to each other until one reaches the internet. AI then ranks who needs help most, and anyone who goes quiet gets flagged so nobody is missed.

How it hits State Farm’s prompt:

Identify the most urgent needs: AI triage scoring
Coordinate assistance: a responder dashboard
Make sure no one is overlooked: silence detection plus the offline mesh

1. Users
Victims: Android app users, plus people who never installed it and reach the agent through Photon.
Responders: State Farm catastrophe teams and volunteers, working from a web dashboard.
2. Architecture
[Android phone A] <--Bluetooth/Wi-Fi Direct--> [Phone B] <--> [Phone C: has signal = gateway]
                                                                  |
[iMessage / WhatsApp / Telegram / voice] --> Photon agent ----> Backend (Express + Postgres)
                                                                  |
                                                 Triage AI (Gemini) + silence detector
                                                                  |
                                                  Responder dashboard (React + map)

Android app (Kotlin)

Use Google Nearby Connections API with the P2P_CLUSTER strategy, which lets many nearby phones connect to each other.
Store-and-forward: every message is saved locally in a Room database and re-broadcast to new peers. Any phone that gets signal becomes a gateway and uploads everything it’s holding.
Loop prevention: each message has a unique ID, a hop count (max ~6) and an expiry time. Phones ignore IDs they’ve already seen.
Permissions:
Android 12+: BLUETOOTH_SCAN, BLUETOOTH_ADVERTISE, BLUETOOTH_CONNECT
Android 13+: NEARBY_WIFI_DEVICES
ACCESS_FINE_LOCATION
Request these at onboarding, not mid-crisis.

Photon agent (Node, @photon-ai/api)

Takes inbound texts and calls and asks short triage questions: injured? how many people? trapped? water rising?
Writes the answers into the same SOS table as app messages.
Sends status updates back: “Help is assigned, ETA 40 min.”

Backend: Express + PostgreSQL, the stack you already know, with WebSockets pushing live updates to the dashboard.

3. Core features (priority order)
One-tap SOS. Big buttons: Injured / Trapped / Need water-meds / Safe. GPS gets attached automatically, with an optional free-text note or voice note.
AI triage score (0–100).
Rules first, for predictability: “trapped + rising water” is always critical.
Gemini second: it reads the free text and pulls out details like “elderly,” “insulin” or “baby.”
Show the reasoning on screen: “Critical: 2 people trapped, mentions oxygen tank. Confidence: high.” Judges reward honest confidence.
Silence detection (your “response detection”).
After an SOS, the system sends check-ins through the app or Photon.
If someone stops responding, their priority goes up, not down.
Also flag dead zones on the map where nobody has checked in at all. Those areas are where people get overlooked.
Disaster-wide heartbeat: when the server opens a disaster event, every phone running the app starts sending a small periodic heartbeat (coarse location, battery, a signed timestamp), over the mesh when offline and straight to the backend when online. This means silence itself is a distress signal, even for people who never pressed SOS. If a phone that was heartbeating goes quiet, especially in an area where its neighbours are still reporting, the backend flags it as possibly in distress and raises its priority. Heartbeats are tiny, low priority and short-lived (few hops, short expiry) so they don't crowd out real SOS traffic, and they stop when the event closes.
Deduplication. Merge reports about the same incident: nearby GPS, similar text, arriving through several relay paths.
Responder dashboard.
Map heat layer plus a ranked queue.
Responders claim a case so two teams don’t go to the same house.
A status trail for each case: reported → assigned → en route → resolved.
4. Data model (minimum)
sos: id, sender_hash, channel (mesh|photon|app), lat, lng, category, text, people_count, score, confidence, reasons[], status, last_heard_at, hop_count, created_at
checkins: sos_id, sent_at, responded_at
assignments: sos_id, responder_id, status, eta
responders: id, role, skills[]
5. Security and privacy (lead with this; it’s your edge)
Signed messages. Each phone generates a keypair (Android Keystore) and signs its SOS messages, so a relay can’t tamper with them in transit. The backend verifies the signature.
Encrypted payloads. Encrypt with the backend’s public key (Google Tink), so relaying phones carry messages they can’t read. Only routing fields like ID, hop count and coarse location stay readable.
Limited exposure. Exact GPS is visible only to the assigned responder. Other users see only a ~1 km area.
Spam and abuse. Rate-limit per device key, and flag anomalies such as one key reporting 50 emergencies.
Retention. Personal data is deleted automatically after the event closes, and only synthetic data is used in the demo.
6. Demo script (3 minutes)
Put 2–3 real Android phones in airplane mode with Bluetooth on. Phone A sends “Trapped, 2 people, water rising.” It hops A → B → C. C goes online and the SOS appears on the dashboard map.
Someone texts the Photon agent from iMessage or WhatsApp. It asks two questions, scores the case and adds it to the queue.
Voice call: someone calls in, the agent triages them by voice, and the case shows up live on the dashboard.
A victim stops answering check-ins. Their card turns red and rises to the top: “No one gets overlooked.”
A responder claims the case and the victim gets “Help is on the way” through the channel they used.
7. Team split
Person 1 (Android/mesh): Nearby Connections, store-and-forward, gateway upload. This is the riskiest part, so give it to your strongest mobile dev and start right now.
Person 2 (Photon agent): text and voice triage flow, two-way status updates.
Person 3 (backend + AI): Express, Postgres, triage scoring, silence detector, deduplication, WebSockets.
Person 4 (dashboard + pitch): React map, ranked queue, case claiming, synthetic disaster data generator, demo script.
8. Timeline (adjust to the hours you have left)
Next 3 hours: two phones exchange one message over Nearby Connections. The Photon agent echoes a text. The backend accepts a POST and stores it.
Tonight: full mesh relay with gateway upload, triage scoring, live dashboard map.
Overnight: silence detection, voice calls, claiming, signing and encryption.
Final 3 hours: stop adding features. Polish the UI, rehearse the demo twice, record a backup video.
9. Risks and fallbacks
Nearby Connections doesn’t work on emulators. You need physical Android phones. Borrow them now if your team doesn’t have 2–3.
If the mesh is flaky during judging, have a backup video. Also add a “simulate relay” mode so the dashboard still demos.
Don’t build: responder accounts beyond a hardcoded list, real State Farm claims integration, or iOS. Mention them as next steps in the pitch.

The thing judges will remember is phones in airplane mode passing an SOS hand to hand until it reaches the dashboard. If that one piece works by tomorrow morning, you’re in good shape. Before Person 2 starts, check Photon’s docs or ask at their booth exactly which channels and voice features are live at this event.

It needs to have a certain number of hops as well

Add hop limits as their own part of the design. Here’s how I’d do it.

Hop design

How hops work: each relay adds 1 to the count before passing a message on. When the count reaches the message’s limit, phones stop forwarding it but still store it. If a stored message ever reaches a phone with signal, it still gets uploaded.

Give urgent messages more hops. More hops means more battery and Bluetooth traffic, so spend them on the people who need help most:

Message type	Max hops	Expires after
Critical (trapped, injured, medical)	10	24 h
High (need water or meds)	7	12 h
Normal / check-in reply	5	6 h
“I’m safe”	3	3 h

Nearby Connections reaches roughly tens of meters per hop, so 10 hops can carry a critical SOS across a neighborhood. You can say that number in the pitch.

Fields to add to each message:

hop_count starts at 0.
max_hops is set by the sending phone based on priority.
expires_at is a fixed time set when the message is created.
hop_path lists anonymized relay IDs, like [A1, B7, C3]. It powers the demo visual.

Security gotcha to mention to the judges: relays have to increment hop_count, so it can’t be inside the sender’s signature. That means a malicious relay could reset it to 0 and keep a message bouncing around forever. The fix is to sign max_hops and expires_at with the payload, so the limit and expiry can’t be changed. Even if someone resets the count, the message still dies at expires_at, and phones drop IDs they’ve already seen. Any phone that sees hop_count > max_hops rejects the message.

Relay logic (Kotlin sketch):

kotlin
fun onMessageReceived(msg: MeshMessage, fromPeer: String) {
    if (seenIds.contains(msg.id)) return                 // dedupe
    if (!crypto.verify(msg.signedPart, msg.signature)) return
    if (now() > msg.expiresAt) return                    // expired
    if (msg.hopCount > msg.maxHops) return               // tampered or over limit

    db.store(msg)                                        // always keep a copy
    seenIds.add(msg.id)

    if (hasInternet()) { uploader.send(msg); return }    // gateway: upload, stop relaying

    if (msg.hopCount < msg.maxHops) {
        val fwd = msg.copy(
            hopCount = msg.hopCount + 1,
            hopPath = msg.hopPath + myRelayId
        )
        peers.filter { it != fromPeer }.forEach { nearby.send(it, fwd) }
    }
}

Delivered receipt (stretch goal): when a gateway uploads a message, the backend sends back a small DELIVERED(id) message, with its own 5-hop limit, through the mesh. Phones holding copies delete them and stop relaying, which saves battery. The original sender also sees “Your SOS reached responders ✓”.

On the dashboard: every SOS card shows “Arrived via 3 hops: A1 → B7 → C3 → gateway,” plus a “Mesh health” panel with average hops, longest relay chain, and how many messages are still waiting offline.

For the demo: add a debug setting that sets max hops to 2. With 4 phones in a line, the message stops at phone 3 because it hit the limit. Then switch it to Critical and it gets through. That shows the hop limit working live, not just on a slide.

Who builds it: this belongs to Person 1 (Android/mesh). Person 3 adds the new fields to the sos table: hop_count, max_hops, hop_path, expires_at.
