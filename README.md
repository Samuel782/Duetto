# Duetto

**English** · [Italiano](README.it.md)

**Live multilingual subtitles for events, conferences and live streams.**

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1X62AXF4L)

Duetto listens to whoever is speaking, transcribes in real time and translates every sentence. Subtitles appear in two places at once, each with its own look and language: over the live stream in OBS Studio and on the big screen in the venue. It can also send them to OBS as real closed captions, which YouTube and Twitch viewers switch on and off.

No stenographer, no interpreters' booth, no code: one laptop and an audio feed from the mixer.

![The control room](docs/img/regia.png)

## Highlights

- **Many languages, in any direction.** Choose up to 6 languages people may speak and up to 8 to translate into, among 19 spoken and 30 written languages. The spoken language is detected sentence by sentence, even when speakers switch without warning; Italian ↔ English works out of the box.
- **Each output in its own language.** For example English over the stream and Spanish on the big screen: only the languages on air are translated.
- **Real captions in the stream.** Through OBS's WebSocket server, viewers on YouTube and Twitch can turn captions on and off.
- **Two independent outputs.** A transparent overlay for OBS and a high-contrast view for the big screen, each with its own style and controls.
- **Full control of the style.** Fonts, sizes, colours, outline, background and position, separately for the original and the translation, saved as presets.
- **Built for hours on air.** It reconnects by itself if the network drops, without losing words, and the audience never sees an error.
- **Subtitle files included.** An SRT file for every language on air and a full transcript, written continuously during the event.
- **Driven from the keyboard.** Start, pause, language and outputs each have a single-key shortcut.

| Streaming (transparent over video) | Big screen in the venue |
|---|---|
| ![Streaming output](docs/img/uscita-streaming.png) | ![Big-screen output](docs/img/uscita-sala.png) |

## How it works

Duetto runs on a **Mac** (macOS 14 or later) or a 64-bit **Windows** PC. Transcription runs on [AssemblyAI](https://www.assemblyai.com) and translation on [DeepL](https://www.deepl.com/pro-api): you need a key for each, and both offer free credit to start. An hour of speech costs roughly one or two euros.

Download it from the [Releases](https://github.com/Samuel782/Duetto/releases) page, open it and paste the two keys. The interface is in English or Italian, following your computer's language or your choice in Settings. At startup Duetto tells you when a new version is available.

The keys stay on your computer, encrypted with the system keychain, and so do the subtitle files. While Duetto is running, audio is sent to AssemblyAI and text to DeepL: let speakers and attendees know if the event requires it. If data must stay in Europe, choose **European Union only** in Settings and AssemblyAI will process the audio on its EU servers.

Subtitles are visible only on the computer running Duetto, unless you allow other devices on the network in Settings. You can also turn off the saved files. Details in [PRIVACY.md](PRIVACY.md); to report a vulnerability, see [SECURITY.md](SECURITY.md). Subtitles are automatic and can contain mistakes: do not rely on them alone where an error could cause harm. In Settings you can show the audience a notice that they are AI-generated.

## Free for you, paid for work

Duetto is **free for noncommercial use**: personal projects, study, schools, nonprofits and public bodies. The code is public, so you can read it, try it and change it.

Commercial use is not free. That's how the project pays for itself:

- **Subtitles as a service.** I run Duetto at events myself, from setup to the files at the end.
- **Commercial licences.** Agencies, AV companies and businesses that want to use Duetto for their own work can get a licence tailored to them.
- **Donations.** If Duetto is useful to you, a [coffee on Ko-fi](https://ko-fi.com/E1X62AXF4L) helps keep it going.

**Want to use Duetto for work? [Get in touch](https://github.com/Samuel782/Duetto/issues) and let's talk.**

## For developers

Duetto is written in Rust with [Tauri](https://tauri.app); the pages are HTML and JavaScript. You need [Rust](https://rustup.rs) and, for the tests, [Node.js](https://nodejs.org) 20 or later.

```bash
npm install
```

```bash
npm run app
```

`npm test` runs the automated tests with fake services, with no network or credit needed. `npm start` runs only the server, for use in a browser: it takes the keys from Settings or from the variables in `.env.example`. `npm run dist` builds the Mac package; GitHub Actions builds the Windows one.

```text
src-tauri/src/      windows, microphone, keychain, safe shutdown
src-tauri/server/   pages, transcription, translation, OBS
src-tauri/core/     text, languages, styles, settings, subtitle files
public/             control room, settings and outputs
test/               automated tests and fake services
```

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Version 1.1.0 and earlier were released under the MIT licence and remain so. AssemblyAI and DeepL are third-party services with their own terms and costs. Bundled software is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
