# Discordio

Discord in SteamOS Game Mode, as a Decky Loader plugin. Voice, servers, friends, calls, Go Live streaming and an in-game overlay, without leaving Big Picture.

**Status: early test builds.** Developed and tested on a Steam Machine running the SteamOS beta channel. Expect rough edges.

## Features

- **Discord in Game Mode:** a full Discord view, opened from the Steam main menu or the Quick Access Menu, with controller navigation (D-pad moves, A selects, B backs out, Y searches, X mutes, bumpers switch servers, triggers scroll, View toggles the on-screen help).
- **Call controls in the QAM:** who's in your call (with mute, deafen and LIVE), mute, deafen, disconnect, push to talk on any controller button.
- **Servers and friends:** browse your servers' voice channels and join one, or call an online friend, straight from the QAM.
- **Go Live:** stream your game with a live preview of exactly what viewers see, resolution from 480p to 4K or source, 5 to 60 fps, and a clear note when a setting needs Nitro.
- **In-game overlay:** your voice channel on top of games, with a speaking highlight. Works alongside Steam's performance overlay.
- **Audio devices:** pick the microphone and speaker / headset Discord uses.
- **Screenshots:** send your latest Steam screenshot to a recent channel or DM.
- **Notifications:** DMs and mentions as Steam toasts, and the game you're playing as your Discord status.
- **Updates from Game Mode:** the QAM checks for new builds and installs them through Decky.
- **Diagnostics:** live health of every part, recent errors, a step-by-step self-test, fix-it buttons and an exportable report.

Discord applies its own limits on stream quality: without Nitro, Go Live is capped at 720p 30 fps.

## Install

In Game Mode: Decky settings → Developer → Install Plugin from URL, with the `Discordio.zip` link from the newest [release](https://github.com/Daggenthal/Discordio/releases). After that, the Updates section in the QAM keeps it current.

Deckcord and Discordio can't run side by side; remove Deckcord first.

## When something doesn't work

Open Discordio in the QAM and go to **Diagnostics**:

1. The summary line says whether anything is wrong, and **Show diagnostics** lists every part (Steam UI, Discord view, Vencord, bridge, account, microphone, screen capture, overlay, updates) with its current state.
2. **Run self-test** checks each part in order and stops at the first one that's broken, with the reason.
3. **Export report** writes `discordio-report.txt` to your home folder with health, errors, settings and recent logs. Attach it when asking for help.
4. Fix-it buttons restart the Discord view or the screen capture, or re-detect the capture method.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| QAM panel | `src/` | Everything you see in the Quick Access Menu, and the microphone side of the mic bridge |
| Backend | `main.py`, `defaults/discordio/` | Creates the Discord view in Steam's UI, runs the bridge, supervises helpers, keeps diagnostics |
| Page scripts | `defaults/page/` | Run inside discord.com: a typed request / event bridge to the backend, the mic and screen-capture hooks, controller navigation |
| Capture helper | `defaults/capture.py` | Turns gamescope's PipeWire feed and game audio into a WebRTC stream for Go Live, finding a capture method that works on the machine |
| Overlay | `defaults/overlay.py`, `defaults/overlay_web.js` | The in-game overlay, as a gamescope overlay or inside Steam's own overlay |

## Building

```sh
pnpm install
scripts/package.sh             # out/Discordio.zip, uses the system's GStreamer for Go Live
```

The GitHub Actions build (`.github/workflows/build.yaml`) uses the Decky CLI, bundles GStreamer, and publishes every build on `main` as a pre-release that the in-QAM updater picks up.

## About Me

I'm Daggenthal. I have a background in IT, I like tinkering with Linux gaming hardware, and I build tools I wish already existed. Discordio started because the existing Discord plugin for Decky stopped working on current SteamOS builds.

## Credits

Discordio began as a fork of [Deckcord](https://github.com/marios8543/Deckcord) by marios8543 (with contributions from AAGaming00, Epictek and jessebofill). The backend, page bridge, microphone bridge and capture helper have since been rewritten from scratch; a few QAM pieces, such as the main menu entry, still come from it. Discordio uses [Vencord](https://vencord.dev/)'s webpack helpers to reach Discord's internals.

## License

Discordio is MIT licensed, see [LICENSE](LICENSE). The remaining code from Deckcord stays under its BSD 3-Clause license, see [LICENSE-Deckcord](LICENSE-Deckcord).
