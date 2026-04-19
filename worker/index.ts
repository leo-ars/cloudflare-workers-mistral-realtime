import { DurableObject } from "cloudflare:workers";

export interface Env {
	TRANSCRIPTION_ROOM: DurableObjectNamespace<TranscriptionRoom>;
	MISTRAL_API_KEY: string;
	ASSETS: Fetcher;
}

interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
}

export class TranscriptionRoom extends DurableObject<Env> {
	private mistralWs: WebSocket | null = null;
	private isReady = false;
	private conversationHistory: ConversationMessage[] = [];
	private currentTranscript = "";
	private systemInstructions = "You are a helpful voice assistant. Keep responses concise and conversational. Respond in the same language as the user.";
	private lastTextTime = 0;
	private silenceCheckInterval: ReturnType<typeof setInterval> | null = null;
	private isProcessingResponse = false;

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message === "string") {
			try {
				const data = JSON.parse(message);
				if (data.type === "start") {
					this.currentTranscript = "";
					this.isProcessingResponse = false;
					if (data.systemInstructions) {
						this.systemInstructions = data.systemInstructions;
					}
					await this.connectToMistral();
				} else if (data.type === "stop") {
					await this.handleStop();
				} else if (data.type === "clear_history") {
					this.conversationHistory = [];
					this.sendToBrowser(JSON.stringify({ type: "history_cleared" }));
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
		this.stopSilenceCheck();
		await this.closeMistralConnection();
	}

	private async handleStop(): Promise<void> {
		this.stopSilenceCheck();

		await this.closeMistralConnection();

		if (this.currentTranscript.trim() && !this.isProcessingResponse) {
			await this.handleConversation(this.currentTranscript.trim());
		}

		this.currentTranscript = "";
	}

	private startSilenceCheck(): void {
		this.stopSilenceCheck();
		this.lastTextTime = Date.now();

		this.silenceCheckInterval = setInterval(() => {
			const now = Date.now();
			const silenceDuration = now - this.lastTextTime;

			if (
				this.currentTranscript.trim() &&
				silenceDuration > 2000 &&
				!this.isProcessingResponse
			) {
				this.triggerConversationResponse();
			}
		}, 500);
	}

	private stopSilenceCheck(): void {
		if (this.silenceCheckInterval) {
			clearInterval(this.silenceCheckInterval);
			this.silenceCheckInterval = null;
		}
	}

	private async triggerConversationResponse(): Promise<void> {
		if (this.isProcessingResponse || !this.currentTranscript.trim()) return;

		this.stopSilenceCheck();

		const transcript = this.currentTranscript.trim();
		this.currentTranscript = "";

		await this.closeMistralConnection();

		await this.handleConversation(transcript);
	}

	private async connectToMistral(): Promise<void> {
		const apiKey = this.env.MISTRAL_API_KEY;
		if (!apiKey) {
			this.sendToBrowser(
				JSON.stringify({
					type: "error",
					message: "MISTRAL_API_KEY is not configured.",
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
					this.startSilenceCheck();
					break;

				case "session.updated":
					break;

				case "transcription.text.delta":
					this.currentTranscript += data.text;
					this.lastTextTime = Date.now();
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

	private async handleConversation(userMessage: string): Promise<void> {
		this.isProcessingResponse = true;

		this.conversationHistory.push({ role: "user", content: userMessage });

		this.sendToBrowser(JSON.stringify({ type: "assistant_thinking" }));

		try {
			const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.env.MISTRAL_API_KEY}`,
				},
				body: JSON.stringify({
					model: "mistral-medium-latest",
					messages: [
						{ role: "system", content: this.systemInstructions },
						...this.conversationHistory,
					],
					temperature: 0.7,
					max_tokens: 1024,
					stream: true,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "Unknown error");
				throw new Error(`Mistral API error (${response.status}): ${errorText}`);
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body");

			const decoder = new TextDecoder();
			let assistantMessage = "";
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;

					const data = trimmed.slice(6);
					if (data === "[DONE]") continue;

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) {
							assistantMessage += delta;
							this.sendToBrowser(
								JSON.stringify({ type: "assistant_delta", text: delta }),
							);
						}
					} catch {
						// Ignore parse errors for incomplete JSON
					}
				}
			}

			if (buffer.trim()) {
				const trimmed = buffer.trim();
				if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
					try {
						const parsed = JSON.parse(trimmed.slice(6));
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) {
							assistantMessage += delta;
							this.sendToBrowser(
								JSON.stringify({ type: "assistant_delta", text: delta }),
							);
						}
					} catch {
						// Ignore
					}
				}
			}

			if (assistantMessage) {
				this.conversationHistory.push({ role: "assistant", content: assistantMessage });
			}

			this.sendToBrowser(JSON.stringify({ type: "assistant_done" }));
		} catch (err) {
			this.sendToBrowser(
				JSON.stringify({
					type: "error",
					message: `Conversation error: ${err instanceof Error ? err.message : String(err)}`,
				}),
			);
		} finally {
			this.isProcessingResponse = false;
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

	private async closeMistralConnection(): Promise<void> {
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		chunks.push(String.fromCharCode(...slice));
	}
	return btoa(chunks.join(""));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/transcribe") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}
			const id = env.TRANSCRIPTION_ROOM.newUniqueId();
			const stub = env.TRANSCRIPTION_ROOM.get(id);
			return stub.fetch(request);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
