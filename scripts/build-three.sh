#!/bin/sh
# Rebuilds public/vendor/three.min.js: a minified, tree-shaken build of only
# the Three.js classes public/dial3d.js uses. The app has no build step, so
# the output is committed; rerun this after changing the dial's imports or
# bumping the version.
set -e
VERSION=0.186.1
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm init -y >/dev/null
npm install --silent "three@$VERSION" esbuild
cat > entry.js <<'JS'
export {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Points,
  TorusGeometry, PlaneGeometry, BufferGeometry, BufferAttribute,
  ShaderMaterial, Color, MathUtils, CustomBlending, AddEquation,
  OneFactor, ZeroFactor,
} from 'three';
JS
npx esbuild entry.js --bundle --minify --format=esm --legal-comments=none \
  --banner:js="/* three.js ${VERSION} (subset) | MIT License | threejs.org */" \
  --outfile="$OLDPWD/public/vendor/three.min.js"
