/* Build script: bundles the content script with esbuild and assembles dist/. */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// The AudioWorklet processor is pre-bundled and self-contained inside the
// @soundtouchjs/audio-worklet package. Copy it verbatim into the extension so
// it can be registered via browser.runtime.getURL('soundtouch-processor.js').
const processorPath = require.resolve('@soundtouchjs/audio-worklet/processor');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

copy(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
copy(path.join(srcDir, 'panel.css'), path.join(distDir, 'panel.css'));
copy(path.join(srcDir, 'background.js'), path.join(distDir, 'background.js'));
copy(path.join(srcDir, 'THIRD_PARTY_NOTICES.txt'), path.join(distDir, 'THIRD_PARTY_NOTICES.txt'));
copy(path.join(srcDir, 'icons', 'icon.svg'), path.join(distDir, 'icons', 'icon.svg'));
copy(processorPath, path.join(distDir, 'soundtouch-processor.js'));

esbuild.buildSync({
  entryPoints: [path.join(srcDir, 'content.js')],
  bundle: true,
  outfile: path.join(distDir, 'content.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox120'],
  minify: false,
  legalComments: 'eof',
  logLevel: 'info',
});

console.log('Build complete ->', distDir);
