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

    // [P6 H] D's P6 wall-pack lobe (record type 3): vectors from seoul-nightlm.js lobePack at p6/D-light 14f871e
    func testWallPackLobe() throws {
        let v: [[Double]] = [[0, -1, 0, 1, 0, 0.9181252629999999],
                             [0.34199998461000103, -0.9396999577135028, 0, 1, 0, 1.0000000629999997],
                             [-0.34199998461000103, -0.9396999577135028, 0, 1, 0, 0.7108064759812946],
                             [0.502518907629606, -0.7035264706814485, 0.502518907629606, 0, 1, 0.7856818231010101],
                             [0.8082903768654761, -0.5773502691896258, 0.11547005383792516, 1, 0, 0.7694998583333335],
                             [0, 1, 0, 1, 0, 0],
                             [0.204926207831424, -0.973399487199264, -0.102463103915712, 0.6, 0.8, 0.9037651729317584]]
        for r in v { XCTAssertEqual(Lobes.pack(r[0], r[1], r[2], r[3], r[4]), r[5], accuracy: 1e-12) }
        // the export's lobe table, once D's change is in it: id 3 and the same solid angle
        if let b = try? bundle(), let lj = try? JSONSerialization.jsonObject(with: b.data("light.json")) as? [String: Any],
           let p = Self.find(lj, "pack") {
            XCTAssertEqual(p["id"] as? Int, Lobe.pack.rawValue)
            if let om = p["omega"] as? Double { XCTAssertEqual(om, Lobes.packOmega, accuracy: 1e-6) }
        }
    }
    /// the first dictionary under key `k` inside a "lobes" object anywhere in light.json
    static func find(_ o: Any, _ k: String) -> [String: Any]? {
        if let d = o as? [String: Any] {
            if let l = d["lobes"] as? [String: Any], let p = l[k] as? [String: Any] { return p }
            for v in d.values { if let r = find(v, k) { return r } }
        } else if let a = o as? [Any] { for v in a { if let r = find(v, k) { return r } } }
        return nil
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
