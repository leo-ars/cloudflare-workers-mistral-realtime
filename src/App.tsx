import { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

type Status = "idle" | "connecting" | "recording" | "stopping" | "thinking";

interface Message {
	role: "user" | "assistant";
	content: string;
}

function App() {
	const [status, setStatus] = useState<Status>("idle");
	const [transcript, setTranscript] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [language, setLanguage] = useState<string | null>(null);
	const [conversationMode, setConversationMode] = useState(true);
	const [messages, setMessages] = useState<Message[]>([]);
	const [assistantResponse, setAssistantResponse] = useState("");

	const wsRef = useRef<WebSocket | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);

	// Auto-scroll to bottom when messages change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, assistantResponse]);

	const cleanup = useCallback(() => {
		if (workletRef.current) {
			workletRef.current.disconnect();
			workletRef.current = null;
		}
		if (audioCtxRef.current) {
			audioCtxRef.current.close();
			audioCtxRef.current = null;
		}
		if (streamRef.current) {
			streamRef.current.getTracks().forEach((t) => t.stop());
			streamRef.current = null;
		}
		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}
	}, []);

	// Cleanup on unmount
	useEffect(() => cleanup, [cleanup]);

	const startAudioCapture = useCallback(async (ws: WebSocket) => {
		const audioCtx = new AudioContext();
		audioCtxRef.current = audioCtx;

		await audioCtx.audioWorklet.addModule("/audio-processor.js");

		const source = audioCtx.createMediaStreamSource(streamRef.current!);
		const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
		workletRef.current = worklet;

		worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(e.data);
			}
		};

		source.connect(worklet);
		setStatus("recording");
	}, []);

	const startRecording = useCallback(async () => {
		try {
			setStatus("connecting");
			setError(null);
			setTranscript("");
			setAssistantResponse("");
			setLanguage(null);

			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
			});
			streamRef.current = stream;

			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${proto}//${location.host}/api/transcribe`);
			wsRef.current = ws;

			ws.binaryType = "arraybuffer";

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data as string);
					switch (data.type) {
						case "ready":
							startAudioCapture(ws).catch((err) => {
								setError(err instanceof Error ? err.message : "Audio capture failed");
								setStatus("idle");
								cleanup();
							});
							break;
						case "text_delta":
							setTranscript((prev) => prev + data.text);
							break;
						case "language":
							setLanguage(data.language);
							break;
						case "transcription_done":
							// In conversation mode, user message will be added when assistant starts
							break;
						case "assistant_thinking":
							setStatus("thinking");
							// Add user message to chat
							setMessages((prev) => [...prev, { role: "user", content: transcript }]);
							setTranscript("");
							setAssistantResponse("");
							break;
						case "assistant_delta":
							setAssistantResponse((prev) => prev + data.text);
							break;
						case "assistant_done":
							// Move streaming response to messages
							setMessages((prev) => {
								const lastAssistant = assistantResponse;
								if (lastAssistant) {
									return [...prev, { role: "assistant", content: lastAssistant }];
								}
								return prev;
							});
							setAssistantResponse("");
							setStatus("idle");
							break;
						case "history_cleared":
							setMessages([]);
							break;
						case "error":
							setError(data.message);
							setStatus("idle");
							break;
					}
				} catch {
					/* ignore parse errors */
				}
			};

			ws.onerror = () => {
				setError("WebSocket connection failed");
				setStatus("idle");
				cleanup();
			};

			ws.onclose = () => {
				if (status === "recording") setStatus("idle");
			};

			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true });
				ws.addEventListener("error", () => reject(new Error("Connection failed")), { once: true });
			});

			ws.send(JSON.stringify({ type: "start", conversationMode }));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start recording");
			setStatus("idle");
			cleanup();
		}
	}, [cleanup, startAudioCapture, status, conversationMode, transcript, assistantResponse]);

	const stopRecording = useCallback(() => {
		setStatus("stopping");
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "stop" }));
		}
		cleanup();
		setStatus("idle");
	}, [cleanup]);

	const clearHistory = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "clear_history" }));
		}
		setMessages([]);
		setTranscript("");
		setAssistantResponse("");
	}, []);

	return (
		<div className="app">
			<header className="header">
				<h1>{conversationMode ? "Voice Assistant" : "Live Transcription"}</h1>
				<p className="subtitle">
					Powered by Mistral Voxtral &amp; Cloudflare Workers
				</p>
			</header>

			{/* Mode toggle */}
			<div className="mode-toggle">
				<button
					className={`mode-btn ${!conversationMode ? "active" : ""}`}
					onClick={() => setConversationMode(false)}
					disabled={status !== "idle"}
				>
					Transcription
				</button>
				<button
					className={`mode-btn ${conversationMode ? "active" : ""}`}
					onClick={() => setConversationMode(true)}
					disabled={status !== "idle"}
				>
					Conversation
				</button>
			</div>

			{/* Main content area */}
			{conversationMode ? (
				<div className="chat-container">
					<div className="corner tl" />
					<div className="corner tr" />
					<div className="corner bl" />
					<div className="corner br" />

					<div className="chat-messages">
						{messages.length === 0 && !transcript && !assistantResponse && (
							<div className="chat-placeholder">
								Press the button and speak to start a conversation
							</div>
						)}

						{messages.map((msg, i) => (
							<div key={i} className={`chat-message ${msg.role}`}>
								<div className="message-role">{msg.role === "user" ? "You" : "Assistant"}</div>
								<div className="message-content">{msg.content}</div>
							</div>
						))}

						{/* Current user transcript (while recording) */}
						{transcript && (
							<div className="chat-message user streaming">
								<div className="message-role">You</div>
								<div className="message-content">
									{transcript}
									{status === "recording" && <span className="cursor" />}
								</div>
							</div>
						)}

						{/* Assistant streaming response */}
						{(status === "thinking" || assistantResponse) && (
							<div className="chat-message assistant streaming">
								<div className="message-role">Assistant</div>
								<div className="message-content">
									{assistantResponse || <span className="thinking-dots">Thinking</span>}
									{status === "thinking" && assistantResponse && <span className="cursor" />}
								</div>
							</div>
						)}

						<div ref={messagesEndRef} />
					</div>
				</div>
			) : (
				<div className="transcript-card">
					<div className="corner tl" />
					<div className="corner tr" />
					<div className="corner bl" />
					<div className="corner br" />

					{language && <div className="language-badge">{language}</div>}

					<div className="transcript-content">
						{transcript || (
							<span className="placeholder">
								{status === "recording"
									? "Listening — start speaking…"
									: "Press the button below to begin real-time transcription"}
							</span>
						)}
						{status === "recording" && <span className="cursor" />}
					</div>
				</div>
			)}

			{/* Error banner */}
			{error && (
				<div className="error-banner">
					<span>⚠</span> {error}
				</div>
			)}

			{/* Controls */}
			<div className="controls">
				{status === "idle" ? (
					<button className="btn-primary" onClick={startRecording}>
						<MicIcon />
						{conversationMode ? "Hold to Speak" : "Start Recording"}
					</button>
				) : status === "connecting" ? (
					<button className="btn-disabled" disabled>
						<span className="spinner" />
						Connecting…
					</button>
				) : status === "thinking" ? (
					<button className="btn-disabled" disabled>
						<span className="spinner" />
						Thinking…
					</button>
				) : (
					<button className="btn-stop" onClick={stopRecording}>
						<span className="stop-icon">■</span>
						Stop
					</button>
				)}
			</div>

			{/* Secondary actions */}
			<div className="secondary-actions">
				{transcript && status === "idle" && !conversationMode && (
					<button
						className="btn-ghost"
						onClick={() => navigator.clipboard.writeText(transcript)}
					>
						Copy transcript
					</button>
				)}
				{conversationMode && messages.length > 0 && status === "idle" && (
					<button className="btn-ghost" onClick={clearHistory}>
						Clear conversation
					</button>
				)}
			</div>

			<footer className="footer">
				<code>voxtral-mini-transcribe-realtime-2602</code>
				{conversationMode && <> + <code>mistral-medium-latest</code></>}
			</footer>
		</div>
	);
}

function MicIcon() {
	return (
		<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
			<rect x="7" y="1" width="6" height="11" rx="3" />
			<path d="M4 9a6 6 0 0 0 12 0" />
			<line x1="10" y1="15" x2="10" y2="19" />
			<line x1="7" y1="19" x2="13" y2="19" />
		</svg>
	);
}

export default App;
