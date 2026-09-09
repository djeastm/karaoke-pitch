# Karaoke Pitch

A browser extension that lets you shift a YouTube video's pitch up or down
(±12 semitones, one full octave) **without changing the tempo**, so you can
sing along to karaoke videos in a key that suits your voice.

Works on desktop Firefox, Firefox for Android, and Chrome.

## How it works

A content script routes the YouTube `<video>` element's audio through the Web
Audio API:

```
video → MediaElementAudioSourceNode → SoundTouchNode (pitch shift) → GainNode → speakers
```

- Pitch shifting is performed by [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS)
  running in an `AudioWorklet` (no deprecated `ScriptProcessorNode`).
- The `GainNode` mirrors YouTube's own volume/mute controls, because
  `MediaElementAudioSourceNode` does not apply them itself.
- The floating panel is draggable (mouse and touch) and its setting is saved
  with `storage.local`.
- Click **Save** (left of Reset) to remember the current pitch for that video
  on this device. When you return, the highlighted **Use −2 st** button (for
  example) restores your saved pitch only when clicked. **Saved ✓** means the
  current pitch already matches. Adjust the slider or use **− / +**, then click
  **Save** to replace the saved value. **Reset** returns to zero without deleting
  the saved pitch, so you can click the button to restore it again.
- The panel is **hidden by default**. Click the toolbar button (🎵 Karaoke Pitch)
  to show or hide it — handy for turning it off when you're not watching a
  karaoke video. The toolbar button is a master switch: hiding the panel also
  disables the pitch effect (audio reverts to normal) and showing it re-enables
  it. The button is gray when the panel is hidden and turns full-color with an
  `ON` badge while it's enabled.

## Requirements

- Node.js ≥ 18
- Firefox desktop ≥ 120, Firefox for Android ≥ 120, or Chrome ≥ 116

## Build

```sh
npm install
npm run build           # both targets
npm run build:firefox   # dist/firefox only
npm run build:chrome    # dist/chrome only
```

Each target gets its own folder — `dist/firefox/` and `dist/chrome/` —
containing `manifest.json`, the bundled `content.js` and `background.js`,
`panel.css`, icons, and the web-accessible `soundtouch-processor.js`.

All of `src/` is shared. The two targets diverge in exactly two places, both
handled by `build.js`:

- **Manifest.** `src/manifest.json` is the Firefox manifest and is shipped
  verbatim. The Chrome one is derived from it, so the version and description
  can't drift: the gecko-only keys and `action.default_area` are dropped,
  `background.scripts` becomes `background.service_worker`, the icons are
  repointed at PNGs, and `minimum_chrome_version` is added.
- **Icons.** Chrome supports SVG in neither the manifest nor `action.setIcon()`,
  so the build rasterizes `src/icons/*.svg` to PNGs at 16/32/48/128 with
  `sharp`. Firefox keeps using the SVGs. `background.js` receives the right icon
  paths through an esbuild `define`.

Both targets share one API shim — `globalThis.browser ?? globalThis.chrome` —
rather than a polyfill, since every API used here (`storage.local`, `runtime`,
`tabs`, `action`) has been promise-based in Chrome since version 88. `browser`
is checked first because Firefox also defines a callback-style `chrome` alias.

## Test on Firefox desktop

```sh
npm run run
```

`web-ext run` launches a temporary Firefox profile with the extension loaded.
Click the toolbar button to show the panel, then open a karaoke video and use
**− / +** or the slider, and confirm the key changes while the tempo stays the
same. Then verify:

- Navigating between videos and refreshing keeps working (no console errors
  about `createMediaElementSource`).
- YouTube's volume slider and mute button still affect the sound.
- The setting persists after reloading the page.
- Save different pitches for two videos, navigate between them without a full
  reload, and verify each offers its own saved value without applying it
  automatically. Check that Reset preserves it and manual adjustments can be
  saved as a replacement. A saved pitch of zero should work too.

## Test on Chrome

```sh
npm run build:chrome
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load
unpacked**, and select `dist/chrome/`. Pin the toolbar button, then run through
the same checks as the Firefox list above. Two things worth confirming
specifically on Chrome:

- The pitch effect works at all. Chrome resolves the AudioWorklet through
  `chrome.runtime.getURL()`; if the extension API were unavailable the worklet
  would fail to load and the audio would play unshifted.
- The toolbar icon and `ON` badge are still correct after Chrome has idled the
  service worker (it restarts on demand and re-derives that state).

## Test on Firefox for Android

Release Firefox for Android only installs add-ons listed on
[addons.mozilla.org](https://addons.mozilla.org). Two options:

1. **Temporary (development):** use Firefox **Nightly** or **Beta**, enable a
   custom add-on collection containing this extension, or load it via
   `about:debugging` over USB.
2. **Production:** submit to AMO (below) and install the listed add-on on
   release Firefox for Android.

## Publish to addons.mozilla.org (AMO)

1. Change `browser_specific_settings.gecko.id` in `src/manifest.json` to a
   unique ID you control (the placeholder `karaoke-pitch@example.com` is not
   submittable). The manifest already declares `"gecko_android": {}` (required
   to list the add-on for Firefox for Android) and
   `data_collection_permissions` (this extension collects nothing).
2. Run `npm run lint` and fix any warnings.
3. Set your AMO API credentials as environment variables (create them at
   <https://addons.mozilla.org/developers/addon/api/key/>):

   ```sh
   export WEB_EXT_API_KEY=user:123456:789
   export WEB_EXT_API_SECRET=your-secret
   ```

   Then sign and submit:

   ```sh
   npm run sign
   ```

   The listing metadata (summary, category, license) comes from
   `amo-metadata.json`. `web-ext sign` uploads the package to AMO; you can also
   upload the `dist/firefox/` ZIP manually at <https://addons.mozilla.org/developers/>.

## Publish to the Chrome Web Store

```sh
npm run build:chrome
npm run package:chrome
```

This writes `web-ext-artifacts/karaoke_pitch-<version>-chrome.zip` with
`manifest.json` at the archive root, ready to upload at the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole). Unlike
AMO, this step is manual and needs a one-time $5 developer registration fee.

The listing also asks for justifications, which are worth having ready:

- **Single purpose:** shifts the pitch of YouTube audio for singing along.
- **`storage` permission:** remembers the chosen pitch and the panel's
  visibility, per video, on the local device.
- **`youtube.com` host access:** the extension only functions on YouTube watch,
  Shorts, embed, and live pages, where the `<video>` element it processes lives.
- **Data use:** nothing is collected or transmitted; all state stays in
  `storage.local`.

## Limitations

- Designed for **1× playback speed**. Changing YouTube's playback speed while
  the effect is active can reduce audio quality, because the pitch shifter is
  tuned for real-time 1× streaming.
- The panel is hidden while the video is in fullscreen (the fullscreen element
  is rendered in its own top layer).
- Works on standard YouTube videos. DRM/encrypted media (rare on YouTube) is
  not accessible to Web Audio and will be bypassed automatically.

## License

MPL-2.0. Third-party notices are in `THIRD_PARTY_NOTICES.txt`.
