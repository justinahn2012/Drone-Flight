// Parity tests for the native slice (PARITY.md). [P6 H] Run in CI on Linux (native-linux) and macOS (native-macos)
// against the same commit's export; first compiled and passed (5/5) on main bc45fbe's export, Swift 6.1.2 Linux.
// Run: ONETAKE_EXPORT=/path/to/exports/seoul-hongdae swift test   (the CI "exports" artifact, or a local export)
import XCTest
@testable import SeoulBundle

final class ParityTests: XCTestCase {
    // vectors from geohash.js (node -e: new GeoHash()...)
    func testGeoHashVectors() {
        XCTAssertEqual(GeoHash().hex(), "ebb6c22840c3ae08")
        var s = GeoHash(); s.str("soup"); XCTAssertEqual(s.hex(), "200f620da5cd55ae")
        var t = GeoHash(); t.str("soup"); t.word(1)
        let f: [Float] = [0, 1, 2, 3.5, -4.25, 5, 1e-3, 600.125, -7]; _ = f.withUnsafeBufferPointer { t.floats($0) }
        XCTAssertEqual(t.hex(), "548932860d2092b2")
        var u = GeoHash(); u.uints([1, 2, 3, 0xffffffff]); XCTAssertEqual(u.hex(), "0443f58f3cf89db5")
    }

    // [P6 H] FIPS 180-4 vectors: the portable SHA-256 (Linux) and the platform one (CryptoKit on Apple) agree
    func testSHA256Vectors() {
        let v: [(String, String)] = [("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
                                     ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
                                     (String(repeating: "a", count: 1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")]
        for (m, h) in v { XCTAssertEqual(SHA256Hex.portable(Data(m.utf8)), h); XCTAssertEqual(SHA256Hex.hex(Data(m.utf8)), h) }
    }

    // [P6 H, native #2] the night lightmap: the file the browser ships, read with the key check, decoded bit for bit
    func testNightLightmap() throws {
        let b = try bundle()
        let L = (try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any])["lightmap"] as! [String: Any]
        guard L["status"] as? String != "stale", let file = L["file"] as? String, let key = L["key"] as? String else { return XCTFail("light.json lightmap is stale: \(L["note"] ?? "")") }
        let d = try b.data(file), t = try NightLM(d, key: key)
        XCTAssertEqual(t.width, L["width"] as! Int); XCTAssertEqual(t.height, L["height"] as! Int)
        XCTAssertEqual(t.texels.count, t.width * t.height)
        let want = L["texelHash"] as? String; XCTAssertNotNil(want, "light.json lightmap.texelHash (tools/export-seoul-data.mjs, P6)")
        var h = GeoHash(); h.str("nlm"); h.uints(t.texels); XCTAssertEqual(h.hex(), want ?? "", "decoded texels = the JS decode")
        let lit = t.texels.filter { $0 != 0 }.count, tx = L["texels"] as? [String: Int] ?? [:]
        XCTAssertGreaterThanOrEqual(lit, (tx["ground"] ?? 0) + (tx["facade"] ?? 0) / 2, "lit texels")
        let (r, g, bb) = NightLM.rgb(t.texels[t.texels.count / 2]); XCTAssert(r.isFinite && g.isFinite && bb.isFinite)
        XCTAssertThrowsError(try NightLM(d, key: "0000000000000000"), "a stale key must be refused (the game's rule)")
    }

    func bundle() throws -> SeoulBundle {
        guard let p = ProcessInfo.processInfo.environment["ONETAKE_EXPORT"] else { throw XCTSkip("set ONETAKE_EXPORT to an export directory") }
        return try SeoulBundle(dir: URL(fileURLWithPath: p))
    }
    func testFilesIntact() throws { XCTAssertEqual(try bundle().staleFiles(), []) }

    func testColliderBitExact() throws {
        let b = try bundle(), soup = try b.colliderSoup(), col = b.world["collider"] as! [String: Any]
        XCTAssertEqual(soup.count / 9, col["triangles"] as! Int)
        XCTAssertEqual(SeoulBundle.soupHash(soup), col["soupHash"] as! String)
    }

    func testWorldMeshesDecode() throws {
        let b = try bundle(); var g = try GLB(b.data("world.glb"))
        let rows = b.world["meshes"] as! [[String: Any]]
        XCTAssertEqual(g.meshes.count, rows.count)
        for (m, r) in rows.enumerated() {
            let (pos, idx) = try g.positionsAndIndex(mesh: m)
            XCTAssertEqual((idx?.count ?? pos.count / 3) / 3, r["triangles"] as! Int, r["name"] as! String)
            let bounds = r["bounds"] as! [String: [Double]], mn = bounds["min"]!, mx = bounds["max"]!
            for c in 0 ..< 3 {   // 20-bit mantissa: within 2 mm of the game's bounds
                let vals = stride(from: c, to: pos.count, by: 3).map { Double(pos[$0]) }
                XCTAssertEqual(vals.min()!, mn[c], accuracy: 0.002); XCTAssertEqual(vals.max()!, mx[c], accuracy: 0.002)
            }
        }
    }

    func testPackedStreamsDecode() throws {
        let b = try bundle()
        let packed = ((b.world["data"] as! [String: Any])["packed"] as! [String: Any])["files"] as! [String: [String: Any]]
        for (f, p) in packed { XCTAssertEqual(try b.unpacked(f).count, p["decodedBytes"] as! Int, f) }
    }
}
