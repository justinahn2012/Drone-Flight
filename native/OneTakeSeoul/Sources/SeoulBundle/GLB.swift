// A minimal glTF 2.0 binary reader for the One Take exports: the container, accessors, and EXT_meshopt_compression
// bufferViews (decoded through meshoptimizer's C decoder; KHR_mesh_quantization formats are returned as stored, the
// caller uploads them to Metal as is: float3 / short4 snorm / ushort index). UNTESTED.
import Foundation
import CMeshopt

public struct GLB {
    public let json: [String: Any]
    public let bin: Data
    var decoded: [Int: Data] = [:]

    public init(_ data: Data) throws {
        func u32(_ o: Int) -> UInt32 { data.subdata(in: o ..< o + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } }
        guard data.count >= 20, u32(0) == 0x46546c67, u32(4) == 2, Int(u32(8)) == data.count else { throw GLBError.header }
        let jl = Int(u32(12)); guard u32(16) == 0x4e4f534a else { throw GLBError.header }
        guard let j = try JSONSerialization.jsonObject(with: data.subdata(in: 20 ..< 20 + jl)) as? [String: Any] else { throw GLBError.json }
        json = j
        let o = 20 + jl
        bin = o < data.count ? data.subdata(in: o + 8 ..< o + 8 + Int(u32(o))) : Data()
    }
    public enum GLBError: Error { case header, json, view(Int), meshopt(Int32) }

    var views: [[String: Any]] { json["bufferViews"] as? [[String: Any]] ?? [] }
    var accessors: [[String: Any]] { json["accessors"] as? [[String: Any]] ?? [] }
    public var meshes: [[String: Any]] { json["meshes"] as? [[String: Any]] ?? [] }

    /// The bytes of a bufferView, decoded when it carries EXT_meshopt_compression (ATTRIBUTES / TRIANGLES / INDICES,
    /// filters NONE / OCTAHEDRAL / EXPONENTIAL). Laid out as the view describes (byteStride per element).
    public mutating func view(_ i: Int) throws -> Data {
        if let d = decoded[i] { return d }
        let v = views[i]
        guard let ext = (v["extensions"] as? [String: Any])?["EXT_meshopt_compression"] as? [String: Any] else {
            let off = v["byteOffset"] as? Int ?? 0, len = v["byteLength"] as! Int
            return bin.subdata(in: off ..< off + len)
        }
        let off = ext["byteOffset"] as? Int ?? 0, len = ext["byteLength"] as! Int, stride = ext["byteStride"] as! Int, count = ext["count"] as! Int
        let mode = ext["mode"] as! String, filter = ext["filter"] as? String ?? "NONE"
        var out = Data(count: count * stride)
        let src = bin.subdata(in: off ..< off + len)
        let rc: Int32 = out.withUnsafeMutableBytes { dst in src.withUnsafeBytes { s in
            let sp = s.bindMemory(to: UInt8.self).baseAddress!, dp = dst.baseAddress!
            switch mode {
            case "ATTRIBUTES":
                let r = meshopt_decodeVertexBuffer(dp, count, stride, sp, len)
                if r == 0 && filter == "OCTAHEDRAL" { meshopt_decodeFilterOct(dp, count, stride) }
                if r == 0 && filter == "EXPONENTIAL" { meshopt_decodeFilterExp(dp, count, stride) }
                return r
            case "TRIANGLES": return meshopt_decodeIndexBuffer(dp, count, stride, sp, len)
            default: return meshopt_decodeIndexSequence(dp, count, stride, sp, len)   // INDICES
            }
        } }
        guard rc == 0 else { throw GLBError.meshopt(rc) }
        decoded[i] = out
        return out
    }

    /// Accessor -> (bytes of its view from its offset, element count, byte stride, componentType, type).
    public mutating func accessor(_ i: Int) throws -> (data: Data, count: Int, stride: Int, comp: Int, type: String, normalized: Bool) {
        let a = accessors[i], vi = a["bufferView"] as! Int, d = try view(vi)
        let comps = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4][a["type"] as! String]!
        let csz = [5126: 4, 5125: 4, 5123: 2, 5122: 2, 5121: 1, 5120: 1][a["componentType"] as! Int]!
        let stride = views[vi]["byteStride"] as? Int ?? comps * csz, off = a["byteOffset"] as? Int ?? 0
        return (d.subdata(in: off ..< d.count), a["count"] as! Int, stride, a["componentType"] as! Int, a["type"] as! String, a["normalized"] as? Bool ?? false)
    }

    /// POSITION (float3) of a mesh's first primitive, and its index (or nil).
    public mutating func positionsAndIndex(mesh m: Int) throws -> (pos: [Float], index: [UInt32]?) {
        let p = ((meshes[m]["primitives"] as! [[String: Any]])[0])
        let pa = try accessor((p["attributes"] as! [String: Int])["POSITION"]!)
        var pos = [Float](repeating: 0, count: pa.count * 3)
        pa.data.withUnsafeBytes { b in for i in 0 ..< pa.count { for c in 0 ..< 3 { pos[i * 3 + c] = b.loadUnaligned(fromByteOffset: i * pa.stride + c * 4, as: Float.self) } } }
        guard let ii = p["indices"] as? Int else { return (pos, nil) }
        let ia = try accessor(ii)
        var idx = [UInt32](repeating: 0, count: ia.count)
        ia.data.withUnsafeBytes { b in for i in 0 ..< ia.count { idx[i] = ia.comp == 5125 ? b.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self) : UInt32(b.loadUnaligned(fromByteOffset: i * 2, as: UInt16.self)) } }
        return (pos, idx)
    }
}
