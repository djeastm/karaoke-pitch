/* Packages dist/chrome into an uploadable ZIP for the Chrome Web Store.
 * Run `npm run build:chrome` first.
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const distDir = path.join(root, 'dist', 'chrome');
const outDir = path.join(root, 'web-ext-artifacts');

if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
  console.error('dist/chrome is missing or incomplete. Run `npm run build:chrome` first.');
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const outFile = path.join(outDir, `karaoke_pitch-${version}-chrome.zip`);

fs.mkdirSync(outDir, { recursive: true });

// The Web Store expects the manifest at the archive root, not nested in a
// folder, so add the directory's contents rather than the directory itself.
const zip = new AdmZip();
zip.addLocalFolder(distDir);
zip.writeZip(outFile);

console.log('Packaged ->', outFile);
