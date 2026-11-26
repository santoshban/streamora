# Streamora for Android

An Android app for a Streamora server on your home network.

- **Browsing** happens in the server's own web UI, shown in a WebView. Profiles, My List, search and the admin pages work as they do in the browser.
- **Playback** happens in a native player (AndroidX Media3 / ExoPlayer). The phone reports which formats it can decode, so most files play as they are:
  - 4K and 10-bit HEVC, AV1 and VP9 when the phone has the decoder
  - MKV, MP4, WebM, AVI and MPEG-TS
  - Dolby Digital (AC3), Dolby Digital Plus (E-AC3), TrueHD and DTS audio, through a bundled FFmpeg decoder
  - Every audio track in the file, switched without restarting the stream
  - Text subtitles, plus the image-based PGS and VobSub subtitles that browsers can't show

  Anything else falls back to the server's HLS remux or transcode, the same as in a browser.
- Progress, resume, the next-episode countdown and the profile's audio and subtitle preferences carry over from the web player.

It needs Android 8.0 or newer. Download `Streamora-<version>.apk` from the [releases page](https://github.com/santoshban/streamora/releases), or build it yourself (below).

## Connecting to the server

The app loads the web UI from the server, so the server must accept connections from other devices:

- **Windows desktop app:** right-click the tray icon and turn on **Let other devices on my network connect**. Windows may ask whether to allow Streamora through the firewall; allow it on private networks.
- **`npm start`:** the server listens on all interfaces by default (`HOST=0.0.0.0`). Run `npm run build` first, so it has a web UI to serve.

On first launch the app scans your Wi-Fi network for servers on ports 8484 to 8486. You can also type an address such as `192.168.1.20:8484`. To switch servers later, open the profile menu and choose **Change server**.

### Away from home

The app remembers every address of your server. After you sign in, it asks the server for them (`GET /api/server/addresses`): home-network addresses, Tailscale addresses and any `ADVERTISED_URLS`.
- **At launch and whenever the phone's network changes**, it tries them all at once and uses the best one that answers: the home network when the phone is on Wi-Fi, otherwise the VPN, then the rest.
- **Your sign-in carries over** between the addresses, because the server's ID (in `/api/health`) shows they lead to the same server.

See [Watching away from home](../README.md#watching-away-from-home) for setting up Tailscale.

## Building

You need JDK 17 or newer and the Android SDK with platform 37. Android Studio includes both. Without it:

- Install a JDK, for example [Temurin 21](https://adoptium.net/), and set `JAVA_HOME` to it.
- Install the [Android command-line tools](https://developer.android.com/studio#command-line-tools-only), then run `sdkmanager "platforms;android-37.0"`.
- Point the build at the SDK with `ANDROID_HOME`, or with a `local.properties` file in this folder containing `sdk.dir=/path/to/Android/Sdk`.

Then, in this folder:

```bash
./gradlew assembleRelease     # Windows: gradlew.bat assembleRelease
```

The APK is written to `release/Streamora-<version>.apk`, where the version is `appVersion` in `app/build.gradle.kts`. Install it with `adb install -r release/Streamora-0.2.0.apk`, or copy it to the phone and open it there; Android will ask you to allow installs from that app.

The release build is signed with your machine's Android debug key (`~/.android/debug.keystore`, created on the first build), so it installs without setting up a keystore. Android only installs an update over an existing copy when it is signed with the same key: if you build on another computer, uninstall the old app first, or copy that keystore across.

`./gradlew testDebugUnitTest` runs the unit tests.

## How it fits together

The web UI checks for `window.StreamoraAndroid` (see `frontend/src/lib/native.ts`). Only pages from the server's own address get it. Inside the app, links to `/watch/<file>` go to the native player instead of the web one. The player signs in with the WebView's session cookie and uses the same API as the web player:

1. `GET /api/catalog/files/:id/context` for the title, resume position, next episode and profile preferences.
2. `POST /api/files/:id/playback` with the phone's capabilities. They include `selectsAudioTrack`, so the server allows direct play of a file whose preferred audio track isn't the default one.
3. Progress goes to `PUT /api/progress/:id` every 10 seconds. HLS sessions are kept alive while paused and closed when the player closes.

When the player closes, the app fires `streamora:app-resumed` in the page, which reloads progress bars and Continue Watching.

## License

The app's source code is MIT, like the rest of Streamora.

The APK also includes [Jellyfin's build of the Media3 FFmpeg decoder](https://github.com/jellyfin/jellyfin-androidx-media) (`org.jellyfin.media3:media3-ffmpeg-decoder`), which is licensed under GPL-3.0. An APK that contains it is a combined work under GPL-3.0. That's fine for your own use. If you share the APK with others, share it under GPL-3.0 terms, which this open-source repository already makes easy. To build an APK without it, remove the `media3.ffmpeg.decoder` dependency from `app/build.gradle.kts` and the `FfmpegLibrary` checks in `DeviceCapabilities.kt`. Phones without their own Dolby or DTS decoder then get those files transcoded by the server.
