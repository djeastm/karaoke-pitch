/* Build script: bundles the extension and assembles a dist/ folder per target.
 *
 *   node build.js            -> builds every target
 *   node build.js chrome     -> builds dist/chrome only
 *   node build.js firefox    -> builds dist/firefox only
 *
 * Firefox and Chrome share all of src/; they diverge only in the manifest
 * (background scripts vs. service worker, gecko-only keys) and in the icon
 * format, since Chrome supports neither SVG icons in the manifest nor SVG
 * passed to action.setIcon().
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = __dirname;
const srcDir = path.join(root, 'src');
const baseManifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));

// The AudioWorklet processor is pre-bundled and self-contained inside the
// @soundtouchjs/audio-worklet package. Copy it verbatim into the extension so
// it can be registered via runtime.getURL('soundtouch-processor.js').
const processorPath = require.resolve('@soundtouchjs/audio-worklet/processor');

// Chrome rasterizes nothing for us, so ship the sizes it asks for: 16 (favicon
// and context menus), 32 (Windows), 48 (extensions page), 128 (Web Store).
const PNG_SIZES = [16, 32, 48, 128];
// Intrinsic width/height declared by src/icons/*.svg.
const SVG_SIZE = 32;
const pngPaths = (name) =>
  Object.fromEntries(PNG_SIZES.map((size) => [size, `icons/${name}-${size}.png`]));

const TARGETS = {
  firefox: {
    outDir: path.join(root, 'dist', 'firefox'),
    esbuildTarget: 'firefox120',
    // Firefox renders SVG at any size, so one file covers every slot.
    icons: { enabled: 'icons/icon.svg', disabled: 'icons/icon-disabled.svg' },
    manifest: (manifest) => manifest,
  },
  chrome: {
    outDir: path.join(root, 'dist', 'chrome'),
    esbuildTarget: 'chrome116',
    icons: { enabled: pngPaths('icon'), disabled: pngPaths('icon-disabled') },
    manifest: (manifest) => {
      // gecko IDs, the Android stub and data_collection_permissions are all
      // Firefox-only; Chrome warns about unrecognized keys.
      delete manifest.browser_specific_settings;
      // default_area places the button in Firefox's navbar; Chrome has no
      // equivalent and rejects the key.
      delete manifest.action.default_area;
      // Chrome MV3 has no persistent background page.
      manifest.background = { service_worker: 'background.js' };
      manifest.icons = pngPaths('icon');
      manifest.action.default_icon = pngPaths('icon-disabled');
      // Well below what this extension needs (MV3 promise APIs landed in 88);
      // set as a conservative floor for a currently-supported Chrome.
      manifest.minimum_chrome_version = '116';
      return manifest;
    },
  },
};

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function writePngIcons(outDir) {
  await Promise.all(
    [['icon.svg', 'icon'], ['icon-disabled.svg', 'icon-disabled']].flatMap(([svg, name]) =>
      PNG_SIZES.map((size) =>
        // The source SVGs declare a 32px intrinsic size, and sharp rasterizes at
        // that size before resizing. Scale the render density up to match the
        // output instead, so 48 and 128 are drawn sharp rather than upscaled.
        sharp(path.join(srcDir, 'icons', svg), { density: Math.ceil((72 * size) / SVG_SIZE) })
          .resize(size, size)
          .png()
          .toFile(path.join(outDir, 'icons', `${name}-${size}.png`))
      )
    )
  );
}

async function build(name) {
  const target = TARGETS[name];
  const { outDir } = target;

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

  // Re-parse per target so one target's manifest edits cannot leak into another.
  const manifest = target.manifest(JSON.parse(JSON.stringify(baseManifest)));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const file of ['panel.css', 'saved.html', 'saved.css']) {
    copy(path.join(srcDir, file), path.join(outDir, file));
  }
  copy(path.join(srcDir, 'THIRD_PARTY_NOTICES.txt'), path.join(outDir, 'THIRD_PARTY_NOTICES.txt'));
  copy(processorPath, path.join(outDir, 'soundtouch-processor.js'));

  if (name === 'chrome') {
    await writePngIcons(outDir);
  } else {
    copy(path.join(srcDir, 'icons', 'icon.svg'), path.join(outDir, 'icons', 'icon.svg'));
    copy(path.join(srcDir, 'icons', 'icon-disabled.svg'), path.join(outDir, 'icons', 'icon-disabled.svg'));
  }

  for (const entry of ['content.js', 'background.js', 'saved.js']) {
    esbuild.buildSync({
      entryPoints: [path.join(srcDir, entry)],
      bundle: true,
      outfile: path.join(outDir, entry),
      format: 'iife',
      platform: 'browser',
      target: [target.esbuildTarget],
      // background.js reads its icon paths from this build-time constant,
      // because the two targets ship different icon formats.
      define: { __KP_ICONS__: JSON.stringify(target.icons) },
      minify: false,
      legalComments: 'eof',
      logLevel: 'warning',
    });
  }

  console.log(`Build complete (${name}) ->`, outDir);
}

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(TARGETS);
  for (const name of names) {
    if (!TARGETS[name]) {
      throw new Error(`Unknown target "${name}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);
    }
  }
  for (const name of names) await build(name);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// Exported so tests can assert on the per-target manifests without paying for a
// full build.
module.exports = { TARGETS, baseManifest, manifestFor: (name) =>
  TARGETS[name].manifest(JSON.parse(JSON.stringify(baseManifest))) };
