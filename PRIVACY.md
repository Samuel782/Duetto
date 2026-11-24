# Privacy

**English** · [Italiano](PRIVACY.it.md)

How the Duetto software handles data, when you install it and run it yourself.
It is not the privacy notice for your event: that depends on who organises it.

## What the author receives

Nothing from your events. Duetto has no accounts, analytics or advertising, and no server run by its author.

## What leaves the computer

| What | Where | When |
|---|---|---|
| Audio, spoken languages and the list of names and terms | AssemblyAI | While subtitles are running, with your key |
| Sentences, the preceding context and the glossary | DeepL | When there is something to translate, with your key |
| Subtitles | OBS, at the address you set | Only if you turn on captions for OBS |
| Subtitles | Devices on the local network | Only if you allow it in Settings |
| A request with your IP address | GitHub | At startup and when you turn the check on, to look for updates |
| A request with your IP address and the font name | Google Fonts | Only if you choose a Google font |

Links to Ko-fi and GitHub open in your browser only when you click them.
AssemblyAI, DeepL, GitHub and Google process data under their own terms.
The traffic to OBS and to devices on the local network is not encrypted: use a network you trust.

## What stays on the computer

- **Settings, languages and presets**, including the API keys and OBS password. In the desktop app those secrets are encrypted with the system keychain when it is available; from the command line they are not.
- **Transcript and SRT files**, in `Documents/Duetto`, until you delete them. You can turn them off in Settings. If that folder is synchronised with a cloud service, they go there too.
- **A technical log**, limited in size. It is meant for status and errors, not for transcripts.

Duetto does not save the audio. Removing the app does not delete these files.

## If you use it at an event

Voices and words can be personal data. Whoever organises or runs the event is responsible for informing people,
for the agreements with the providers and for how long files are kept. Automatic subtitles can contain mistakes.
