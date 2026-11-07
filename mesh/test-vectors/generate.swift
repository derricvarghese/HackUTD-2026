// Regenerates envelope_v1.json: a real signed envelope that has taken 2 hops.
// Run from this directory:  swift generate.swift > envelope_v1.json
import CryptoKit
import Foundation

let key = P256.Signing.PrivateKey()
let pubDER = key.publicKey.derRepresentation
func relayId(_ der: Data) -> String { SHA256.hash(data: der).prefix(2).map { String(format: "%02X", $0) }.joined() }

let createdAt: Int64 = 1_762_500_000_000
let header: [String: Any] = [
    "v": 1,
    "id": "6f1c2a9e-3b4d-4c5e-8f60-71829a0b1c2d",
    "pub": pubDER.base64EncodedString(),
    "kind": "sos",
    "pri": "critical",
    "maxHops": 10,
    "createdAt": createdAt,
    "expiresAt": createdAt + 24 * 3_600_000,
    "body": ["category": "trapped", "text": "Trapped, 2 people, water rising", "lat": 32.9857,
             "lng": -96.7502, "acc": 8.5, "people": 2],
]
let signed = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys, .withoutEscapingSlashes])
let sig = try key.signature(for: signed).derRepresentation
let origin = relayId(pubDER)

let out: [String: Any] = [
    "description": "Critical SOS signed by a throwaway P-256 key, after 2 hops (origin + one relay). Every platform must verify it.",
    "expectedId": header["id"]!,
    "expectedOriginRelayId": origin,
    "envelope": [
        "v": 1,
        "signed": signed.base64EncodedString(),
        "sig": sig.base64EncodedString(),
        "hop": 2,
        "path": [origin, "B7C2"],
    ],
]
let data = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
print(String(data: data, encoding: .utf8)!)
