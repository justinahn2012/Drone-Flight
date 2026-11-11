// Parity tests for the native slice (PARITY.md). UNTESTED here (no Swift toolchain on the export box).
// Run: ONETAKE_EXPORT=/path/to/exports/seoul-hongdae swift test   (the CI "exports" artifact, or a local export)
import XCTest
@testable import SeoulBundle

final class ParityTests: XCTestCase {
    // vectors from geohash.js (node -e: new GeoHash()...)
    func testGeoHashVectors() {
        XCTAssertEqual(GeoHash().hex(), "ebb6c22840c3ae08")
        var s = GeoHash(); s.str("soup"); XCTAssertEqual(s.hex(), "200f620da5cd55ae")
        var t = GeoHash(); t.str("soup"); t.word(1)
        let f: [Float] = [0, 1, 2, 3.5, -4.25, 5, 1e-3, 600.125, -7]; f.withUnsafeBufferPointer { t.floats($0) }
        XCTAssertEqual(t.hex(), "548932860d2092b2")
        var u = GeoHash(); u.uints([1, 2, 3, 0xffffffff]); XCTAssertEqual(u.hex(), "0443f58f3cf89db5")
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
