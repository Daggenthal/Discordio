<div align="center">

# Discordio

**Discord in SteamOS Game Mode.** Voice chat, calls, messages, Go Live and an in-game overlay, all from the Quick Access Menu, without ever leaving your game.

[![Stable release](https://img.shields.io/github/v/release/Daggenthal/Discordio?label=stable&color=5865F2)](https://github.com/Daggenthal/Discordio/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Daggenthal/Discordio/total?color=23a55a)](https://github.com/Daggenthal/Discordio/releases)
[![License: MIT](https://img.shields.io/github/license/Daggenthal/Discordio?color=f0b232)](LICENSE)
![SteamOS](https://img.shields.io/badge/SteamOS-Game%20Mode-1a9fff?logo=steam&logoColor=white)
![Decky Loader](https://img.shields.io/badge/Decky-Loader-ed4245)

<!-- Screenshot or GIF of the Quick Access Menu goes here -->

[Install](#-install) · [Features](#-features) · [Why I Made It](#-why-i-made-discordio) · [Before you start](#-before-you-start) · [Troubleshooting](#-when-something-doesnt-work) · [Credits](#credits)

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

### 🏪 Why Isn't It on the Decky Store?

Decky's Plugin Store doesn't accept plugins that use AI-assisted code ([their submission rules](https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins)). Since parts of Discordio were written with Claude Code, it can't be listed there. I fully understand why, and I get where they're coming from. This is just a heads up in case you were wondering why you won't find it in the store. Installing from the URL above works the same way, and Discordio keeps itself updated after that.

---

## ✨ Features

**🔑 Easy Discord Login:** When launching Discordio for the first time, you can quickly scan the QR code from your mobile app. Discord then keeps running in the background with low resource usage.

**🎧 Easy Call Controls:** Join a VC, leave it, mute yourself, and mute individuals or control their volume. If you're a moderator or have the right permissions, you can Server Mute, Server Deafen, or disconnect them from the VC.

**📺 Simple Game Streaming:** Discordio pipes through Vencord and captures your whole display, pushing through full video and audio. Before going live, you get the options you're used to on Discord: Quality (480p to Source) and Frame Rate. Some settings are Nitro only, and your account is checked automatically, since Discord is already running in the background.

**👀 Watch Your Friends Stream:** Select them in the VC and watch their stream full screen (with audio, of course), or as an overlay you control. Move it to any corner (top-left, bottom-right, etc.) and resize it with a slider that goes up to 300%, so it fits your screen.

**🎙️ Audio Settings:** Before going live, you can test your mic, tweak settings like Noise Suppression, and change your input and output devices, so everything "Just Works", as Todd Howard has always intended.

**📞 Answering Calls:** Answering calls is a breeze. Set your own controller keybinds to accept or decline, and you'll hear the call come in, with a notification showing who's calling.

**👥 Friends:** See your friends list and view anyone's profile in its entirety (banner, bio, badges and all). Send them a message, react to their messages with one of your recent emojis (or pick a specific one), and reply directly to their messages. Discordio also pulls in your GIFs, showing your Favorites first, and lets you search.

**➕ Adding Friends:** Search someone's Discord username and send them a friend request, all without touching your phone.

**🗂️ Servers:** View all the servers you're in, see their VCs, join them, and get the same call controls there too.

**🪪 Your Profile:** At the top of Discordio, select your profile to see your banner, badges, and the rest.

**💬 Status:** Change your status, set a custom status emoji (fully animated, like normal), and choose when your status disappears, or keep it forever.

**🎮 MangoHud and Calls:** If you have Steam's performance overlay (MangoHud) open to see your FPS and someone calls you, Discordio swaps it off (remembering the setting it was at) and shows you who's calling. When you accept, you'll see the usual Discord overlay showing who's talking, who's live, and who's muted or deafened. Once you leave the call, Discordio puts your MangoHud setting back so everything goes back to normal.

**🔔 Messages:** When someone messages you, a notification pops up in whatever corner you set. It shows their name and message, and you can open Discordio to pick the conversation right back up.

<!-- More screenshots / GIFs: calls, the overlay, a profile, messages -->

---

## 💭 Why I Made Discordio

What I focused on most with Discordio was making it as seamless as possible. It gives us the same control we have in the app, while keeping it simple and easy to read and use. I wanted something that let me keep Discord open while playing with the homies, and the other options at the time just didn't cut it or had issues. So I started working on this myself, then used Claude Code (Pro) to work on the rest. I combed over the code myself as well, and heavily tested each feature.

If something isn't working, there's a Diagnostics section at the bottom where you can get your logs. They're anonymized, and you can read them yourself if you'd like. Feel free to send them to me so I can take a look.

Discordio is MIT, as I believe in fully open source. I've daily-driven Linux since 2008 and run FreeBSD on some of my servers too. If you build on this, all you have to do is follow the MIT license and put me (Daggenthal) in your credits.

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
