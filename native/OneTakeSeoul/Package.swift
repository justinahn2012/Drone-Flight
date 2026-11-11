// swift-tools-version:5.9
// One Take FPV, Neon Seoul: the native slice's loader + parity tests (P4 stream H, native #6).
// UNTESTED: written on a Linux box with no Swift / Metal toolchain. See PARITY.md for what it must reproduce.
import PackageDescription

let package = Package(
    name: "OneTakeSeoul",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "SeoulBundle", targets: ["SeoulBundle"])],
    targets: [
        // meshoptimizer's decoder (MIT). Vendor src/vertexcodec.cpp, src/indexcodec.cpp, src/vertexfilter.cpp and
        // src/meshoptimizer.h (as include/meshoptimizer.h) from zeux/meshoptimizer v1.3.0 (the exporter's encoder,
        // ci/package.json): `sh fetch-meshopt.sh`. The export uses codec v0 (EXT_meshopt_compression).
        .target(name: "CMeshopt", path: "Sources/CMeshopt", publicHeadersPath: "include"),
        .target(name: "SeoulBundle", dependencies: ["CMeshopt"], path: "Sources/SeoulBundle"),
        .testTarget(name: "SeoulBundleTests", dependencies: ["SeoulBundle"], path: "Tests/SeoulBundleTests"),
    ],
    cxxLanguageStandard: .cxx17
)
