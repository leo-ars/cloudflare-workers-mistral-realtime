import { DurableObject } from "cloudflare:workers";

export interface Env {
	TRANSCRIPTION_ROOM: DurableObjectNamespace<TranscriptionRoom>;
	MISTRAL_API_KEY: string;
	ASSETS: Fetcher;
}

/**
 * Durable Object that bridges a browser WebSocket to Mistral's realtime
 * transcription WebSocket API. One instance per transcription session.
 *
 * Browser  ──ws──▸  TranscriptionRoom  ──ws──▸  Mistral API
 *   (PCM binary)       (base64 JSON)
 */
export class TranscriptionRoom extends DurableObject<Env> {
	private mistralWs: WebSocket | null = null;
	private isReady = false;

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	// --- Hibernatable WebSocket handlers ---

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message === "string") {
			try {
				const data = JSON.parse(message);
				if (data.type === "start") {
					await this.connectToMistral();
				} else if (data.type === "stop") {
					await this.stopTranscription();
				}
			} catch (err) {
				ws.send(
					JSON.stringify({
						type: "error",
						message: `Invalid message: ${err instanceof Error ? err.message : String(err)}`,
					}),
				);
			}
		} else {
			// Binary audio data → forward to Mistral as base64 JSON
			if (this.mistralWs && this.isReady) {
				try {
					const base64 = arrayBufferToBase64(message);
					this.mistralWs.send(
						JSON.stringify({
							type: "input_audio.append",
							audio: base64,
						}),
					);
				} catch (err) {
					console.error("Failed to forward audio to Mistral:", err);
				}
			}
		}
	}

	async webSocketClose(): Promise<void> {
		await this.stopTranscription();
	}

	// --- Mistral connection management ---

	private async connectToMistral(): Promise<void> {
		const apiKey = this.env.MISTRAL_API_KEY;
		if (!apiKey) {
			this.sendToBrowser(
				JSON.stringify({
					type: "error",
					message:
						"MISTRAL_API_KEY is not configured. Run: npx wrangler secret put MISTRAL_API_KEY",
				}),
			);
			return;
		}

		const model = "voxtral-mini-transcribe-realtime-2602";
		const url = `https://api.mistral.ai/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`;

		try {
			const resp = await fetch(url, {
				headers: {
					Upgrade: "websocket",
					Authorization: `Bearer ${apiKey}`,
				},
			});

			const ws = resp.webSocket;
			if (!ws) {
				const body = await resp.text().catch(() => "Unknown error");
				this.sendToBrowser(
					JSON.stringify({
						type: "error",
						message: `Failed to connect to Mistral (HTTP ${resp.status}): ${body}`,
					}),
				);
				return;
			}

			ws.accept();
			this.mistralWs = ws;

			ws.addEventListener("message", (event) => {
				this.handleMistralMessage(event.data as string);
			});

			ws.addEventListener("close", () => {
				this.mistralWs = null;
				this.isReady = false;
			});

			ws.addEventListener("error", () => {
				this.sendToBrowser(
					JSON.stringify({
						type: "error",
						message: "Mistral WebSocket connection error",
					}),
				);
			});
		} catch (err) {
			this.sendToBrowser(
				JSON.stringify({
					type: "error",
					message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
				}),
			);
		}
	}

	private handleMistralMessage(rawData: string): void {
		try {
			const data = JSON.parse(rawData);

			switch (data.type) {
				case "session.created":
					// Configure the audio format, then signal browser to start streaming
					if (this.mistralWs) {
						this.mistralWs.send(
							JSON.stringify({
								type: "session.update",
								session: {
									audio_format: {
										encoding: "pcm_s16le",
										sample_rate: 16000,
									},
								},
							}),
						);
					}
					this.isReady = true;
					this.sendToBrowser(JSON.stringify({ type: "ready" }));
					break;

				case "session.updated":
					// Audio format confirmed – nothing extra to do
					break;

				case "transcription.text.delta":
					this.sendToBrowser(
						JSON.stringify({ type: "text_delta", text: data.text }),
					);
					break;

				case "transcription.language":
					this.sendToBrowser(
						JSON.stringify({ type: "language", language: data.language }),
					);
					break;

				case "transcription.segment":
					// Segment-level delta – forward as-is for debugging
					break;

				case "transcription.done":
					this.sendToBrowser(JSON.stringify({ type: "transcription_done" }));
					break;

				case "error":
					this.sendToBrowser(
						JSON.stringify({
							type: "error",
							message:
								typeof data.error?.message === "string"
									? data.error.message
									: JSON.stringify(data.error),
						}),
					);
					break;

				default:
					console.log("Unknown Mistral event:", data.type);
					break;
			}
		} catch (err) {
			console.error("Failed to parse Mistral message:", err);
		}
	}

	private sendToBrowser(message: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				// Browser socket may already be closed
			}
		}
	}

	private async stopTranscription(): Promise<void> {
		if (this.mistralWs) {
			try {
				this.mistralWs.send(JSON.stringify({ type: "input_audio.flush" }));
				this.mistralWs.send(JSON.stringify({ type: "input_audio.end" }));
			} catch {
				/* ignore */
			}
			try {
				this.mistralWs.close(1000, "Transcription stopped");
			} catch {
				/* ignore */
			}
			this.mistralWs = null;
			this.isReady = false;
		}
	}
}

/** Convert ArrayBuffer → base64 string (chunked to avoid stack overflow). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const chunkSize = 0x8000; // 32 KiB
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		chunks.push(String.fromCharCode(...slice));
	}
	return btoa(chunks.join(""));
}

// --- Worker entry point ---

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/transcribe") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}
			// Each session gets its own DO instance
			const id = env.TRANSCRIPTION_ROOM.newUniqueId();
			const stub = env.TRANSCRIPTION_ROOM.get(id);
			return stub.fetch(request);
		}

		// Let the static assets middleware handle everything else
		// Return undefined/null to pass through to assets
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
