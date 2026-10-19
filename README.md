# Voice Input ZH

An Obsidian voice-input plugin built for Traditional Chinese (zh-TW) speakers — especially those who mix in English tech vocabulary while thinking out loud.

Most speech-to-text plugins randomly emit Simplified Chinese and give you no control over post-processing. This one fixes both, and never loses a recording.

## Features

- **Reliable Traditional Chinese** — double enforcement: the transcription call is pinned to Chinese with a zh-TW context prompt, then an optional LLM polish pass converts anything that slipped through into Traditional Chinese (Taiwan usage).
- **Customizable AI polish prompt** — the instructions that clean up your raw transcript (punctuation, filler-word removal, homophone fixes) are fully editable, right in the panel. Toggle the polish pass on/off without leaving the sidebar.
- **Recordings are cached before transcription** — audio is saved into your vault first, so a failed API call never means re-recording. Failed recordings stay in a "Cached recordings" list with one-click retry. Successful ones are auto-deleted (configurable).
- **Clean sidebar UI** — live level meter, recording timer, status indicator, draft transcript that survives restarts, insert-at-cursor / append-to-note / copy actions.

## How it works

```
Record (mic) → save .webm into vault → OpenAI transcription (your language + context prompt)
→ optional LLM polish (your prompt) → editable transcript → insert into your note
```

If the polish step fails, you still get the raw transcript. If transcription fails, the audio file is kept for retry.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Voice Input ZH** and paste your OpenAI API key.
3. Click the microphone ribbon icon (or run the *Open voice input panel* command).

A hotkey can be bound to the *Start/stop recording* command.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Transcription model | `gpt-transcribe` | also `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`. `gpt-transcribe` often outputs Simplified Chinese regardless of the prompt — keep AI polish on |
| Transcription language | `zh` | any ISO-639-1 code; empty = auto-detect |
| Transcription prompt | zh-TW context hint | add your recurring names/jargon here |
| AI polish | on | the LLM cleanup pass |
| Polish model | `gpt-5.4-mini` | any chat-completions model id that accepts `temperature` (reasoning models such as `gpt-6-luna` reject it) |
| Polish prompt | zh-TW cleanup rules | editable in panel too |
| Cache folder | `_voice-input-cache` | inside your vault |
| Keep audio after success | off | failed audio is always kept |
| Max recording length | 15 min | auto-stops and transcribes |

Not a Traditional Chinese speaker? Change the transcription language (or leave it empty for auto-detect) and edit the two prompts — the zh-TW enforcement lives entirely in settings, so the same plugin works for any language OpenAI supports.

## Disclosures

- **Network use**: audio recordings and transcripts are sent to the OpenAI API (`api.openai.com`) for transcription and polishing. Nothing else leaves your machine; there is no telemetry.
- **Paid account required**: you need your own OpenAI API key; API usage is billed by OpenAI.
- **Local files**: recordings are temporarily written inside your vault (`_voice-input-cache/` by default). Your API key is stored in the plugin's local `data.json`.
- **Desktop only**: uses Electron's media APIs.

## Manual installation

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/voice-input-zh/`, then enable the plugin in Settings → Community plugins.

## Development

Plain JavaScript, no build step — edit `main.js` / `styles.css` and reload the plugin. `test/test-view.js` renders the sidebar view against a mini fake DOM for a quick smoke check (`node test/test-view.js`).

## License

MIT
