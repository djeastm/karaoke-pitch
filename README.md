# Karaoke Pitch

A Firefox extension that lets you shift a YouTube video's pitch up or down
(±12 semitones, one full octave) **without changing the tempo**, so you can
sing along to karaoke videos in a key that suits your voice.

Works on desktop Firefox and Firefox for Android.

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
  with `browser.storage.local`.

## Requirements

- Node.js ≥ 18
- Firefox desktop ≥ 120, or Firefox for Android ≥ 120

## Build

```sh
npm install
npm run build
```

This produces a `dist/` folder containing the packaged extension
(`manifest.json`, bundled `content.js`, `panel.css`, and the web-accessible
`soundtouch-processor.js`).

## Test on desktop

```sh
npm run run
```

`web-ext run` launches a temporary Firefox profile with the extension loaded.
Open a karaoke video, use **− / +** or the slider, and confirm the key changes
while the tempo stays the same. Then verify:

- Navigating between videos and refreshing keeps working (no console errors
  about `createMediaElementSource`).
- YouTube's volume slider and mute button still affect the sound.
- The setting persists after reloading the page.

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
   upload the `dist/` ZIP manually at <https://addons.mozilla.org/developers/>.

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
