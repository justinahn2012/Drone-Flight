// The Seoul export as a native bundle (tools/export-world.mjs --level seoul-hongdae): world.json's file table checked
// by sha256, the collider decoded to the game's triangles (collider.soupHash), the packed light / sign streams
// (data.packed, signs.bin) decoded. UNTESTED: see PARITY.md.
import Foundation
import CryptoKit
import CMeshopt

public struct SeoulBundle {
    public let dir: URL
    public let world: [String: Any]

    public init(dir: URL) throws {
        self.dir = dir
        world = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("world.json"))) as! [String: Any]
    }
    public func data(_ f: String) throws -> Data { try Data(contentsOf: dir.appendingPathComponent(f)) }

    /// Files whose bytes or sha256 differ from world.json `files` (empty = the bundle is intact).
    public func staleFiles() throws -> [String] {
        let files = world["files"] as! [String: [String: Any]]
        return try files.keys.sorted().filter { f in
            let d = try data(f), want = files[f]!
            let sha = SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
            return d.count != want["bytes"] as! Int || sha != want["sha256"] as! String
        }
    }

    /// The collider's triangles in index order (x, y, z per vertex): what flight.js collides against, bit for bit.
    public func colliderSoup() throws -> [Float] {
        var g = try GLB(data("collider.glb"))
        let (p, idx) = try g.positionsAndIndex(mesh: 0)
        guard let I = idx else { return p }
        var out = [Float](repeating: 0, count: I.count * 3)
        for (k, v) in I.enumerated() { out[k * 3] = p[Int(v) * 3]; out[k * 3 + 1] = p[Int(v) * 3 + 1]; out[k * 3 + 2] = p[Int(v) * 3 + 2] }
        return out
    }
    /// GeoHash().str("soup").word(triangles).array(soup): must equal world.json collider.soupHash.
    public static func soupHash(_ soup: [Float]) -> String {
        var h = GeoHash(); h.str("soup"); h.word(UInt32(soup.count / 9))
        soup.withUnsafeBufferPointer { h.floats($0) }
        return h.hex()
    }

    /// A file listed in world.json data.packed (light/lightmap.bin, light/volume.bin, ...): its decoded bytes.
    public func unpacked(_ f: String) throws -> Data {
        let packed = ((world["data"] as? [String: Any])?["packed"] as? [String: Any])?["files"] as? [String: [String: Any]]
        let src = try data(f)
        guard let P = packed?[f] else { return src }
        let stride = P["stride"] as! Int, count = P["count"] as! Int
        var out = Data(count: count * stride)
        let rc: Int32 = out.withUnsafeMutableBytes { d in src.withUnsafeBytes { s in meshopt_decodeVertexBuffer(d.baseAddress!, count, stride, s.bindMemory(to: UInt8.self).baseAddress!, src.count) } }
        guard rc == 0 else { throw GLB.GLBError.meshopt(rc) }
        return out
    }
}
