# Discordio

Discord in SteamOS Game Mode, as a Decky Loader plugin. Voice controls, chat, and Go Live streaming with selectable quality, without leaving Big Picture.

**Status: early test builds.** Developed and tested on a Steam Machine running the SteamOS beta channel. Expect rough edges.

## Features

- Discord runs in its own view inside Game Mode. Open it from the Steam main menu or the Quick Access Menu.
- Mute, deafen, disconnect, and see who is in your voice channel from the QAM.
- Push to talk on any controller button you choose (press "Choose push-to-talk button", then press the button).
- Go Live from the QAM, with a quality picker: 720p30, 720p60, 1080p30, 1080p60, 1440p60, or source resolution.
- Post Steam screenshots to your recent channels.
- Shows the game you're playing as your Discord status, plus in-game notifications for DMs and pings.
- A Diagnostics section in the QAM that shows exactly which step failed when something breaks after a Steam or Discord update.

Discord applies its own limits on top of the quality you pick here: without Nitro, Go Live is capped at 720p30.

## Install a test build

Remove Deckcord first if you have it. The two cannot run side by side (the test script does this for you).

From Desktop Mode (Konsole) or over SSH:

```sh
chmod +x discordio-test.sh
./discordio-test.sh install Discordio.zip
```

Then go back to Game Mode and look for Discordio in the Decky tab of the QAM.

If something doesn't work:

```sh
./discordio-test.sh report     # writes ~/discordio-report.txt
./discordio-test.sh logs       # follow the log live while you reproduce the problem
```

## Building

```sh
pnpm install
scripts/package.sh             # out/Discordio.zip, uses the system's GStreamer for Go Live
```

The GitHub Actions build (`.github/workflows/build.yaml`) uses the Decky CLI, which also bundles GStreamer for Go Live.

## About Me

I'm Daggenthal. I have a background in IT, I like tinkering with Linux gaming hardware, and I build tools I wish already existed. Discordio started because the existing Discord plugin for Decky stopped working on current SteamOS builds.

## Credits

Discordio is a fork of [Deckcord](https://github.com/marios8543/Deckcord) by marios8543, with contributions from AAGaming00 (mic support), Epictek (QR code login), and jessebofill (main menu patching). It injects [Vencord](https://vencord.dev/) into Discord's web client.

## License

New work in Discordio is MIT licensed, see [LICENSE](LICENSE). Code inherited from Deckcord remains under its BSD 3-Clause license, see [LICENSE-Deckcord](LICENSE-Deckcord).
