<div align="center">

# Discordio

**Discord in SteamOS Game Mode.** Voice chat, calls, messages, Go Live and an in-game overlay, all from the Quick Access Menu, without ever leaving your game.

[![Stable release](https://img.shields.io/github/v/release/Daggenthal/Discordio?label=stable&color=5865F2)](https://github.com/Daggenthal/Discordio/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Daggenthal/Discordio/total?color=23a55a)](https://github.com/Daggenthal/Discordio/releases)
[![License: MIT](https://img.shields.io/github/license/Daggenthal/Discordio?color=f0b232)](LICENSE)
![SteamOS](https://img.shields.io/badge/SteamOS-Game%20Mode-1a9fff?logo=steam&logoColor=white)
![Decky Loader](https://img.shields.io/badge/Decky-Loader-ed4245)

<!-- Screenshot or GIF of the Quick Access Menu goes here -->

[Install](#-install) · [Features](#-features) · [Before you start](#-before-you-start) · [Troubleshooting](#-when-something-doesnt-work) · [Credits](#credits)

</div>

---

## 🚀 Install

1. Install [Decky Loader](https://decky.xyz/).
2. In Game Mode, open Decky's settings, turn on **Developer mode**, then **Developer → Install Plugin from URL** and paste:

   ```
   https://github.com/Daggenthal/Discordio/releases/latest/download/Discordio.zip
   ```

   That link always points to the newest **Stable** release.
3. Open **Discordio** in the Quick Access Menu and press **Open Discord** to log in. The QR code works with the Discord app on your phone.

After that, Discordio keeps itself up to date from Game Mode. Pick **Stable** for tested releases or **Beta** for every build as soon as it's made.

> [!NOTE]
> Deckcord and Discordio can't run side by side. Remove Deckcord first.

---

## ✨ Features

### 🎧 Voice and calls
- **Your call at a glance:** who's in it, who's talking, muted, deafened or live. Mute, deafen and disconnect right under the call.
- **Per person:** Local Mute and Voice Volume, plus Server Mute, Server Deafen and Server Disconnect when you have the permission. View anyone's profile from the call.
- **Incoming calls:** Discord's ringtone, a call card where your popups appear, and Answer / Decline in the menu or on your controller.
- **Controller keybinds:** set your own buttons for answering, declining and your mic (toggle mute or push to talk). They read the physical buttons, so they work with any controller and any game's layout.
- **Audio Settings:** microphone and speaker choice, noise suppression, echo cancellation, automatic gain, mic sensitivity with its value shown, a microphone test with "hear yourself", and a test sound.

### 📺 Go Live and watching streams
- **Go Live** without Discord ever appearing on screen: 480p to 4K and 5 to 60 fps, with Nitro-only settings marked and Nitro detected automatically.
- **Watch full screen:** just the stream, nothing else. Press B and you're back in your game.
- **Watch in the overlay:** a friend's stream as a picture-in-picture while you keep playing. Pick its corner, size (10% to 300%), frame rate (10 to 60 fps) and volume. It waits through pauses, like a phone being locked.

### 💬 Messages
- **Recent conversations** with unread counts, including DMs that came in while Discordio was off.
- **Read and reply** with images, GIFs, videos and stickers shown inline. Open any picture or video full screen.
- **Reply** to a message, **edit** or **delete** your own, and see who's **typing**.
- **React** with your recent and favorite emojis or any of your servers' emojis, animated ones included.
- **GIFs:** your favorites and Tenor search. **Screenshots:** send a Steam screenshot straight into a conversation.

### 👥 Friends, servers and profiles
- **Friends:** a searchable list with online counts, call, message, join their call or watch their stream. Accept, decline or send friend requests.
- **Servers:** voice and text channels, unread markers, Mark as Read, and favorite voice channels pinned to the top.
- **Profiles,** the way Discord shows them: banner, avatar decoration, theme colours, server tag, badges with their details, bio, connections and mutual friends. Your own badges sit under your name.
- **Status:** Online, Idle, Do Not Disturb or Invisible, plus a custom status with an emoji (animated with Nitro) and a "clear after" timer.

### 🎮 The in-game overlay
- Your voice channel on top of your game with a speaking highlight, plus message popups, call cards and notices.
- Steam's performance overlay steps aside during calls and comes back exactly as you had it.
- Turn it on only for calls, and set its size, opacity and "only show who's talking".

### 🔔 Notifications
- Popups for DMs and mentions, following Discord's own mutes. Mute a server, channel or conversation just for popups.
- Do Not Disturb silences them all.

### 🛠️ Everything else
- **Accounts:** switch between saved accounts, add another, or log out. Your username is in Settings, ready to share.
- **Updates from Game Mode:** a banner when a new build is out; it installs through Decky and reopens itself without leaving your game.
- **Diagnostics:** the health of every part, your SteamOS and Steam versions and channels, how much CPU and memory the Discord page uses, a self-test, fix-it buttons and a shareable report with names and IDs hidden.
- **A tidy menu:** every section collapses from its title or its bottom, and Back to Top closes everything on the way up.

<!-- More screenshots / GIFs: calls, the overlay, a profile, messages -->

---

## 📋 Before you start

> [!WARNING]
> Discordio runs Discord's own web app, with [Vencord](https://vencord.dev/) loaded to reach its internals. Client modifications are against Discord's terms of service. Discord rarely acts on them, but it can, so using Discordio is at your own risk. Consider an alt account if that worries you.

- **The human check.** Discord sometimes asks you to prove you're human, especially right after logging in on a new device. Discordio tells you when; open Discord and complete it once.
- **Game Mode only.** Discordio is built for SteamOS Game Mode. Desktop Mode has the regular Discord app.
- **Nitro limits.** Without Nitro, Discord caps Go Live at 720p 30 fps, and custom emojis only work in their own server.
- **Microphone permission.** The first time Discord asks for the mic, Steam may ask you to allow it.

---

## 🩺 When something doesn't work

Open Discordio in the Quick Access Menu and go to **Diagnostics**:

1. The summary line says whether anything is wrong. Open the section to see every part (Steam UI, Discord view, Vencord, bridge, account, microphone, screen capture, overlay, updates) with its current state, plus your system details.
2. **Run self-test** checks each part in order and stops at the first one that's broken, with the reason.
3. **Export report** writes `discordio-report.txt` to your home folder. Usernames, server names and IDs are replaced with `<name>` and `<id>` unless you turn on "Show names in diagnostics", so it's safe to attach when asking for help.
4. Fix-it buttons open Discord, restart the Discord view or the screen capture, or re-detect the capture method.

---

## 🧩 How it works

| Part | Where | What it does |
| --- | --- | --- |
| QAM panel | `src/` | Everything you see in the Quick Access Menu, and the microphone side of the mic bridge |
| Backend | `main.py`, `defaults/discordio/` | Creates the Discord view in Steam's UI, runs the bridge, supervises helpers, keeps diagnostics |
| Page scripts | `defaults/page/` | Run inside discord.com: a typed request / event bridge to the backend, the mic and screen-capture hooks, controller navigation |
| Capture helper | `defaults/capture.py` | Turns gamescope's PipeWire feed and game audio into a WebRTC stream for Go Live, finding a capture method that works on the machine |
| Overlay | `defaults/overlay.py`, `defaults/overlay_web.js` | The in-game overlay, as a gamescope overlay or inside Steam's own overlay |

## 🔧 Building

```sh
pnpm install
scripts/package.sh             # out/Discordio.zip, uses the system's GStreamer for Go Live
```

The GitHub Actions build (`.github/workflows/build.yaml`) uses the Decky CLI, bundles GStreamer, and publishes every build on `main` as a pre-release: the **Beta** channel.

To release a build on the **Stable** channel, run **Promote a build to stable** in the Actions tab with the build number, or:

```sh
gh release edit build-N --prerelease=false --latest
```

---

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
