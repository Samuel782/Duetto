# Duetto

**English** · [Italiano](README.it.md)

**Two languages, two screens, one control room: live Italian and English subtitles for events, conferences and live streams.**

Speech is transcribed as it is spoken, and every sentence is translated into the other language. The subtitles appear in two places, each with its own look: on the live stream in OBS Studio and on the big screen in the venue.

You don't need a stenographer and you don't need to code: during the event a few keys are all it takes.

The app's interface is in Italian. This guide gives each button's name as it appears on screen, with a translation the first time it comes up.

![The control room](docs/img/regia.png)

## What you need

- A **Mac** (macOS 13 or later) or a 64-bit **Windows** 10 or 11 PC
- An Internet connection: transcription and translation run in the cloud
- The speakers' audio, for example a mixer output connected through a USB audio interface
- Two free keys, explained below: they take a few minutes to get
- OBS Studio, only if you are live streaming

## Installation

### Mac

1. Download the right file for your Mac. If you're not sure which one, open  → *About This Mac*.
   - Apple chip (M1, M2, M3…): `Duetto-1.0.1-mac-arm64.dmg`
   - Intel processor: `Duetto-1.0.1-mac-x64.dmg`
2. Open the file and drag **Duetto** into the **Applications** folder.
3. Open the app. macOS blocks it, because it isn't signed with an Apple certificate. Close the warning.
4. Open *System Settings → Privacy & Security*, scroll down and click **Open Anyway**.
5. When the app asks, allow access to the **microphone**.

The block only happens the first time.

### Windows

1. Download `Duetto-1.0.1-win-x64.zip`.
2. Right-click the file and choose **Extract All**. Don't run the app from inside the zip.
3. In the extracted folder, open **Duetto.exe**.
4. If "Windows protected your PC" appears, click **More info**, then **Run anyway**.
5. If the firewall asks for permission, allow access on private networks. This is only needed to open the subtitles from another computer.

## First launch: the two keys

The keys are the personal codes the app uses to access the transcription and translation services. On first launch the **Impostazioni** (Settings) window opens by itself.

![The Settings window](docs/img/impostazioni.png)

1. **AssemblyAI** (transcription): [create an account](https://www.assemblyai.com/dashboard/signup) and copy the key from the home page.
2. **DeepL** (translation): [create an API account](https://www.deepl.com/pro-api) and copy the key from *Account → API Keys*. You need an **API** account: the regular DeepL Translator account won't do.
3. Paste both keys and click **Salva e verifica** (Save and check). A green tick confirms each key works.

In the same window you can add:

- **Termini da riconoscere** (terms to recognise): speaker names, companies, acronyms. They greatly improve name recognition. List only names and acronyms: common words don't help, and too many terms can make results worse.
- **Glossario** (glossary): fixed translations for specific terms, for example `tavola rotonda,round table`.
- **Pulizia del testo** (text clean-up): removes fillers such as "ehm" and tones down swear words.

### What it costs

| Service | Free offer | Beyond the free offer |
|---|---|---|
| AssemblyAI | $50 of starting credit, about 110 hours | $0.45 per hour of connection |
| DeepL | Up to 1,000,000 characters in total, depending on the plan | Paid plan |

An hour of continuous speech uses about 54,000 DeepL characters. Prices and offers may change: check both services' websites. The control room shows the characters left and an estimate of the credit used.

## Using the app at an event

1. **Choose the audio input** and check that the green bar moves when someone speaks. Nothing is used until you press Avvia.
2. **Connect the outputs:** [OBS](#live-streaming-with-obs) and the [big screen](#big-screen-in-the-venue).
3. **Press Avvia** (Start), or the space bar. Subtitles begin within a couple of seconds.
4. **During breaks press Pausa** (Pause), again with the space bar: no credit is used.
5. **At the end of the event close the app** and get the files with **Apri cartella dei file** (Open files folder).

## Features

### Language: AUTO, IT, EN

A large selector chooses the spoken language. The active one is highlighted in blue, so you can see it from a distance.

- **AUTO** detects the language by itself, sentence by sentence. It is almost always the right choice, even when languages switch without warning.
- **IT** and **EN** tell the app which language is being spoken, and so which way to translate. Use them only when you are sure: with the wrong language the text appears but stays untranslated.

The change applies from the next sentence, and the audience notices nothing.

### Two independent outputs

Streaming and the venue (Sala) each have their own preview and controls. For each output you can choose:

- **Orig. + trad.:** original text and translation together
- **Solo trad.:** translation only, which appears in meaningful chunks
- **Solo orig.:** original text only, which appears as it is spoken
- **Pulisci** (Clear): empties the screen at once
- **Nascondi** (Hide): removes the subtitles until you press Mostra (Show)

### Live streaming with OBS

Subtitles reach OBS with a transparent background, over the video. The checkerboard below stands for transparency.

![Streaming output with a transparent background](docs/img/uscita-streaming.png)

1. In **Collegamenti per OBS e altri computer** (links for OBS and other computers) click **Copia** (Copy) on the OBS row.

   ![The links to copy](docs/img/collegamenti.png)

2. In OBS add a **Browser** source and paste the address.
3. Set width `1920` and height `1080`.
4. Turn off **Shutdown source when not visible**.
5. Place the source above the video.

### Big screen in the venue

Black background, large text and the translation in a different colour, to read from a distance.

![Big-screen output](docs/img/uscita-sala.png)

- **From the same computer:** connect the big screen and click **Apri su maxischermo** (Open on big screen). The subtitles go full screen on the second display. To close them, click that window and press `Esc`.
- **From another computer on the same network:** copy the **Altro computer** (other computer) row and open it in a full-screen browser.

### Custom style

In the **Stile** (Style) panel each output has its own settings, which apply instantly without reloading anything: font, colours, outline, shadow, background, position, margins, number of lines, line length, fade-out.

The original and the translation each have their own font, weight, size, italics and colour. If the translation is smaller, its lines hold more words: **Caratteri per riga** (characters per line) applies to the original, and the translation takes up the same width.

You can save styles under a name and move them to another computer with **Esporta JSON** and **Importa JSON** (export and import). For Google Fonts, type the name and choose **Google Font** as the source: this needs Internet.

![The Style panel](docs/img/stile.png)

### Try it for free

In **Termini, demo e test** (terms, demo and tests), the **Avvia demo** button shows sample sentences on every output, without using credit or writing files: it's the right way to adjust styles. An orange strip reminds you it is on. It stops by itself as soon as real audio starts, but **always check it is off before going live**.

### Subtitle files

During the event the app writes continuously to the **Documents/Duetto** folder, so nothing is lost even after a sudden shutdown. Each launch of the app gets its own subfolder:

| File | Contents |
|---|---|
| `originale.srt` | Each sentence in the language it was spoken in |
| `italiano.srt` | Everything in Italian |
| `inglese.srt` | Everything in English |
| `trascrizione.txt` | The full text with times and language |

The `.srt` files can be uploaded to YouTube and into video editors. Timings are approximate, off by up to about one second.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Start, pause, resume |
| `A` `I` `E` | Language AUTO, IT, EN |
| `1` `2` `3` | Streaming: original + translation, translation only, original only |
| `7` `8` `9` | Venue: original + translation, translation only, original only |
| `4` `5` `6` | Both outputs together |
| `Q` / `W` | Streaming: clear / hide or show |
| `O` / `P` | Venue: clear / hide or show |

Shortcuts don't work while you are typing in a field: click elsewhere in the window to bring them back.

### Built to last hours on air

- **If the network drops**, the app reconnects by itself and recovers the last few seconds of audio. The audience only sees the subtitles disappear and come back; the warning appears only in the control room.
- **AssemblyAI's 3-hour limit** per session is handled automatically, at the end of a sentence, without losing words.
- **If a translation doesn't arrive**, the original text stays visible.
- **The computer doesn't go to sleep** while the app is open.
- **Closing by mistake is hard:** the app asks for confirmation.

## Troubleshooting

| Problem | What to do |
|---|---|
| The level bar doesn't move | Check the chosen input and the mixer. On Mac: *System Settings → Privacy & Security → Microphone*. On Windows: *Settings → Privacy & security → Microphone* |
| Red clipping warning | The signal is too loud: turn it down on the mixer |
| "AssemblyAI rifiuta la connessione" (AssemblyAI refuses the connection) | Open **Impostazioni** and click **Salva e verifica**: the key is wrong or the credit has run out |
| Text appears but no translation | In **Stato** (Status) check the DeepL error and the characters left, and that the language isn't set wrongly |
| Subtitles don't appear in OBS | Check the address again: if the port is busy it can change, so copy it again from the app. Then refresh the source |
| Names transcribed wrongly | Add them to the **Termini da riconoscere** |
| The first words are wrong | That's normal: they correct themselves in about a second |
| The translation arrives after the original | That's normal: it arrives a few seconds later, one meaningful chunk at a time. Lines stay still and change a page at a time, without skipping anything |

The error log is the `app.log` file in the app's data folder:

- **Mac:** `~/Library/Application Support/Duetto`
- **Windows:** `%APPDATA%\Duetto`

## Rehearsal checklist

**The day before**

- [ ] Keys checked with the green tick, and enough DeepL characters
- [ ] Speaker names and acronyms added to the terms
- [ ] Styles adjusted with the demo, in OBS and on the big screen
- [ ] A real test of a few minutes, with the same voices or microphones if possible
- [ ] Automatic updates and notifications turned off on the computer

**On the day**

- [ ] Computer plugged into power
- [ ] Right audio input, and the level bar moving with no red warnings
- [ ] OBS and big screen connected: in **Stato** each output counts at least 2 windows, including the preview
- [ ] Demo off
- [ ] Microphone check, and subtitles checked on both outputs

## Privacy

- While the app is running, audio is sent to **AssemblyAI** and text to **DeepL**. Tell speakers and organisers if the event requires it.
- The keys stay only on your computer, in an unencrypted file in the app's data folder: don't share that folder.
- The subtitles are visible to anyone on the same network who knows the address, but the control room only opens on the computer running the app.

## For developers

You need [Node.js](https://nodejs.org) 20 or later.

```bash
npm install
```

```bash
npm run app
```

The first command installs the dependencies, the second starts the app without packaging it.

To build the packages into the `dist/` folder:

```bash
npm run dist
```

| Command | Result |
|---|---|
| `npm run dist:mac` | `.dmg` for Apple and Intel Macs |
| `npm run dist:win` | `.zip` for Windows, also builds on a Mac |
| `npm run dist:win:installer` | Windows installer and portable `.exe`. On an Apple-chip Mac it needs Rosetta |
| `npm test` | Automated tests with fake services, no network or credit needed |
| `npx electron scripts/screenshots.mjs` | Regenerates the screenshots in this guide |

**Removing the security warnings.** The warnings on first launch only go away if the app is signed, which costs money:

- **Mac:** you need an Apple Developer account. Remove `"identity": "-"` from `package.json` and follow [electron-builder's code signing guide](https://www.electron.build/code-signing).
- **Windows:** you need a code signing certificate, with the same guide.

A command-line version is still available: copy `.env.example` to `.env`, add the keys and run `npm start`.

```text
electron/main.js       windows, permissions, safe shutdown
server/index.js        pages, commands, sentence processing
server/assemblyai.js   session, reconnection, lossless session handover
server/deepl.js        translation, usage, glossary
server/settings.js     keys and preferences
server/store.js        saved state and style schema
server/textclean.js    fillers and swear words
server/transcript.js   SRT and TXT files
public/                app screens and audio capture
test/                  automated tests, fake services, audio file sender
```

## Licence

Released under the [MIT](LICENSE) licence. Uses AssemblyAI and DeepL, third-party services with their own terms and costs.
