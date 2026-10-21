# Discordio

Discord in SteamOS Game Mode, as a Decky Loader plugin. Voice, servers, friends, calls, Go Live streaming and an in-game overlay, without leaving Big Picture.

**Status: early test builds.** Developed and tested on a Steam Machine running the SteamOS beta channel. Expect rough edges.

## Features

- **Discord in Game Mode:** a full Discord view, opened from the Steam main menu or the Quick Access Menu (QAM), with controller navigation (D-pad moves, A selects, B backs out, Y searches, X mutes, bumpers switch servers, triggers scroll, View toggles the on-screen help).
- **Calls from the QAM:** who's in your call with speaking, mute, deafen and LIVE badges; mute, deafen, disconnect; per-person Local Mute and Voice Volume; Server Mute, Server Deafen and Server Disconnect when you have the permission.
- **Incoming calls:** a Steam notification and a banner with Answer and Decline, plus controller shortcuts (default: hold Options/Start and pull R2 to answer, L2 to decline). Shortcuts are rebindable and work on any controller.
- **Servers, friends and favorites:** voice and text channels for every server, a searchable friends list with online counts, join a friend's call, watch their stream, and pin favorite voice channels to the top.
- **Messages:** recent conversations with unread counts, images, GIFs and videos, replies, editing and deleting your own messages, reactions with your own and your servers' emojis, "is typing", your favorite GIFs and GIF search, and sending a Steam screenshot straight into a conversation.
- **Unread and notifications:** unread markers on conversations, servers and channels, Mark as Read, and popup control: DMs, mentions, Discord's own mutes, or mute a server, channel or conversation just for popups.
- **Friend requests:** accept, decline or cancel requests, and add friends by username.
- **Go Live:** stream your game without Discord ever appearing on screen. Resolution from 480p to 4K and 5 to 60 fps, with Nitro-only settings marked and Nitro detected automatically.
- **In-game overlay:** your voice channel on top of games with a speaking highlight, and a friend's stream as a small picture-in-picture while you keep playing. Steam's performance overlay is hidden during calls and restored afterwards. Can turn itself on only during calls; size, opacity, and "only show who's talking" options. Works alongside Steam's performance overlay.
- **Audio Settings:** microphone and speaker choice, noise suppression, echo cancellation, automatic gain, mic sensitivity, a microphone test with "hear yourself", and a test sound.
- **Status and profile:** Online, Idle, Do Not Disturb or Invisible, plus a custom status, and your Discord badges under your name. Do Not Disturb silences Discordio's popups.
- **Accounts:** switch between saved accounts, add another, or log out.
- **Updates from Game Mode:** pick the Stable or Beta channel; Discordio checks when you open it, shows a banner, installs through Decky and reopens itself.
- **Diagnostics:** live health of every part, how much CPU and memory the Discord page uses, a self-test, fix-it buttons and an exportable report. Names and IDs are hidden from diagnostics and reports by default.

## Before you start

- **Discord's terms of service.** Discordio runs Discord's own web app, with [Vencord](https://vencord.dev/) loaded to reach its internals. Client modifications are against Discord's terms of service. Discord rarely acts on them, but it can, and using Discordio is at your own risk. Consider an alt account if that worries you.
- **The human check.** Discord sometimes asks you to prove you're human (a captcha), especially right after logging in on a new device. Discordio tells you when that happens; open Discord and complete it once.
- **Game Mode only.** Discordio is built for SteamOS Game Mode. Desktop Mode has the regular Discord app.
- **Nitro limits.** Without Nitro, Discord caps Go Live at 720p 30 fps.
- **Microphone permission.** The first time Discord asks for the mic, Steam may ask you to allow it.

## Install

1. Install [Decky Loader](https://decky.xyz/).
2. In Game Mode, open Decky settings, turn on Developer mode, then Developer → Install Plugin from URL, and paste the `Discordio.zip` link from the newest [release](https://github.com/Daggenthal/Discordio/releases).
3. Open Discordio in the QAM and press **Open Discord** to log in (the QR code works with the Discord app on your phone).

After that, the Updates section keeps it current. Stable gets tested releases; Beta gets every build as soon as it's made.

Deckcord and Discordio can't run side by side; remove Deckcord first.

## When something doesn't work

Open Discordio in the QAM and go to **Diagnostics**:

1. The summary line says whether anything is wrong, and **Show Diagnostics** lists every part (Steam UI, Discord view, Vencord, bridge, account, microphone, screen capture, overlay, updates) with its current state.
2. **Run self-test** checks each part in order and stops at the first one that's broken, with the reason.
3. **Export report** writes `discordio-report.txt` to your home folder with health, errors, settings and recent logs. Usernames, server names and IDs are replaced with `<name>` and `<id>` unless you turn on "Show names in diagnostics", so the report is safe to attach when asking for help.
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

The GitHub Actions build (`.github/workflows/build.yaml`) uses the Decky CLI, bundles GStreamer, and publishes every build on `main` as a pre-release (the Beta channel).

To release a build on the Stable channel, run the **Promote a build to stable** workflow in the Actions tab with the build number, or:

```sh
gh release edit build-N --prerelease=false --latest
```

## About Me

I'm Daggenthal. I have a background in IT, I like tinkering with Linux gaming hardware, and I build tools I wish already existed. Discordio started because the existing Discord plugin for Decky stopped working on current SteamOS builds.

## Credits

Discordio contains some code from [Deckcord](https://github.com/marios8543/Deckcord), made by [@marios8543](https://github.com/marios8543/), so please feel free to check out the original inspiration if you want to try theirs out!

For compliance's sake, these are the parts that still come from Deckcord:

- [`src/patches/menuPatch.tsx`](src/patches/menuPatch.tsx): the Discord entry in Steam's main menu
- [`src/components/buttons/MuteButton.tsx`](src/components/buttons/MuteButton.tsx) and [`src/components/buttons/DeafenButton.tsx`](src/components/buttons/DeafenButton.tsx): the mute and deafen buttons
- [`src/components/buttons/OpenCloseDiscordButton.tsx`](src/components/buttons/OpenCloseDiscordButton.tsx): the Open Discord button
- [`src/hooks/useDeckcordState.ts`](src/hooks/useDeckcordState.ts): parts of the hook that shares Discord's state with the Quick Access Menu

Everything else (the backend, page bridge, microphone bridge, capture helper and overlay) has been rewritten from scratch. Again, this project would not have been possible without the starting inspiration of Deckcord, and many thanks go to its author and the contributors they thank: AAGaming00, Epictek and jessebofill!

Discordio also uses [Vencord](https://vencord.dev/)'s webpack helpers to reach Discord's internals.

## License

Discordio is MIT licensed, see [LICENSE](LICENSE). The files from Deckcord listed under Credits stay under its BSD 3-Clause license, see [LICENSE-Deckcord](LICENSE-Deckcord).
