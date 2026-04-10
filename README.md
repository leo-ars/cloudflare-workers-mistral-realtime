# Real-time Speech Transcription with Mistral Voxtral & Cloudflare Workers

Live speech-to-text transcription using Mistral's Voxtral realtime API, running entirely on Cloudflare's edge network.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                     │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────────┐  │
│  │  Microphone  │───▶│  AudioWorklet   │───▶│  WebSocket (binary)    │  │
│  │              │    │  (PCM S16LE     │    │  PCM chunks to Worker  │  │
│  │              │    │   16kHz mono)   │    │                        │  │
│  └──────────────┘    └─────────────────┘    └───────────┬────────────┘  │
│                                                         │               │
│  ┌──────────────────────────────────────────────────────┼────────────┐  │
│  │                    React UI                          │            │  │
│  │  • Start/Stop recording                              │            │  │
│  │  • Live transcript display                           ▼            │  │
│  │  • Language detection badge              ◀─── JSON events         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE WORKER                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                 TranscriptionRoom (Durable Object)                 │  │
│  │                                                                    │  │
│  │  • Accepts browser WebSocket (Hibernatable API)                   │  │
│  │  • Opens outbound WebSocket to Mistral API                        │  │
│  │  • Converts binary PCM → base64 JSON for Mistral                  │  │
│  │  • Relays transcription events back to browser                    │  │
│  │                                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                     │
│  ┌─────────────────────────────────┼─────────────────────────────────┐  │
│  │           Static Assets         │                                  │  │
│  │  • React SPA (Vite build)       │                                  │  │
│  │  • AudioWorklet processor       │                                  │  │
│  └─────────────────────────────────┼─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (wss://api.mistral.ai)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         MISTRAL API                                      │
│                                                                          │
│  Model: voxtral-mini-transcribe-realtime-2602                           │
│                                                                          │
│  Input:  { type: "input_audio.append", audio: "<base64 PCM>" }          │
│  Output: { type: "transcription.text.delta", text: "..." }              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
├── worker/
│   └── index.ts          # Cloudflare Worker + TranscriptionRoom Durable Object
├── src/
│   ├── App.tsx           # React UI component
│   ├── App.css           # Cloudflare design system styles
│   ├── index.css         # Base styles
│   └── main.tsx          # React entry point
├── public/
│   └── audio-processor.js # AudioWorklet for PCM capture
├── wrangler.jsonc        # Cloudflare Worker configuration
├── vite.config.ts        # Vite + Cloudflare plugin config
└── package.json
```

## Key Implementation Details

### 1. Audio Capture (AudioWorklet)

The `public/audio-processor.js` AudioWorklet:
- Captures microphone input at native sample rate
- Resamples to 16kHz (required by Mistral)
- Converts Float32 → Int16 PCM S16LE format
- Emits ~100ms chunks via `postMessage`

```javascript
// Resample and convert to PCM S16LE
for (let i = 0; i < this._chunkSamples; i++) {
    const s = Math.max(-1, Math.min(1, this._buf[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
}
this.port.postMessage(pcm.buffer, [pcm.buffer]);
```

### 2. Durable Object WebSocket Bridge

The `TranscriptionRoom` Durable Object:
- Uses Hibernatable WebSocket API for browser connections
- Opens outbound WebSocket to Mistral's realtime endpoint
- Converts binary PCM to base64 JSON for Mistral's protocol
- Handles session lifecycle (start, audio streaming, stop)

```typescript
// Browser sends binary PCM → convert to Mistral's JSON format
const base64 = arrayBufferToBase64(message);
this.mistralWs.send(JSON.stringify({
    type: "input_audio.append",
    audio: base64,
}));
```

### 3. Mistral WebSocket Protocol

**Endpoint:** `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602`

**Client → Server messages:**
- `{ type: "session.update", session: { audio_format: { encoding: "pcm_s16le", sample_rate: 16000 } } }`
- `{ type: "input_audio.append", audio: "<base64>" }`
- `{ type: "input_audio.flush" }`
- `{ type: "input_audio.end" }`

**Server → Client events:**
- `{ type: "session.created", session: {...} }`
- `{ type: "transcription.text.delta", text: "..." }`
- `{ type: "transcription.language", language: "en" }`
- `{ type: "transcription.done" }`
- `{ type: "error", error: {...} }`

### 4. Wrangler Configuration

```jsonc
{
    "name": "mistral-realtime-transcription",
    "main": "worker/index.ts",
    "compatibility_date": "2026-04-09",
    "compatibility_flags": ["nodejs_compat"],
    "assets": {
        "not_found_handling": "single-page-application",
        "binding": "ASSETS"
    },
    "durable_objects": {
        "bindings": [{ "name": "TRANSCRIPTION_ROOM", "class_name": "TranscriptionRoom" }]
    },
    "migrations": [{ "tag": "v1", "new_classes": ["TranscriptionRoom"] }]
}
```

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Mistral API key with access to Voxtral realtime model

### Install

```bash
npm install
```

### Configure Mistral API Key

For local development, create `.dev.vars`:
```
MISTRAL_API_KEY=your-mistral-api-key
```

For production, set as a secret:
```bash
npx wrangler secret put MISTRAL_API_KEY
```

### Development

```bash
npm run dev
```

Opens at `http://localhost:5173`

### Deploy

```bash
npm run deploy
```

## Usage

1. Open the app in a browser (HTTPS required for microphone access in production)
2. Click "Start Recording"
3. Grant microphone permission
4. Speak — transcription appears in real-time
5. Click "Stop Recording" when done
6. Optionally copy the transcript

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "MISTRAL_API_KEY is not configured" | Set the secret: `npx wrangler secret put MISTRAL_API_KEY` |
| No microphone permission | Ensure HTTPS in production, check browser permissions |
| WebSocket connection failed | Check Mistral API key validity and model access |
| Audio not streaming | Verify AudioWorklet loaded (`/audio-processor.js` must be accessible) |

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **Frontend:** React 19 + Vite
- **Audio:** Web Audio API + AudioWorklet
- **Styling:** Cloudflare Design System
- **Build:** @cloudflare/vite-plugin
- **AI:** Mistral Voxtral (`voxtral-mini-transcribe-realtime-2602`)

## License

MIT
