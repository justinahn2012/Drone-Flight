#!/bin/sh
# Vendor meshoptimizer's decoder sources (MIT) into Sources/CMeshopt. Run once on the Mac that builds the package.
set -e
# [P6 H] the git tag is v1.3 (npm 1.3.0): v1.3.0 404s
V=v1.3; B=https://raw.githubusercontent.com/zeux/meshoptimizer/$V/src
cd "$(dirname "$0")/Sources/CMeshopt"
for f in vertexcodec.cpp indexcodec.cpp vertexfilter.cpp; do curl -fsSL "$B/$f" -o "$f"; done
curl -fsSL "$B/meshoptimizer.h" -o include/meshoptimizer.h
curl -fsSL "https://raw.githubusercontent.com/zeux/meshoptimizer/$V/LICENSE.md" -o LICENSE.md
echo "meshoptimizer $V decoder vendored"
