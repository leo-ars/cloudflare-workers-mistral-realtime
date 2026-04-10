import { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

type Status = "idle" | "connecting" | "recording" | "stopping";

function App() {
	const [status, setStatus] = useState<Status>("idle");
	const [transcript, setTranscript] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [language, setLanguage] = useState<string | null>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const streamRef = useRef<MediaStream | null>(null);

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
		// Don't connect to destination – we don't want to play back the mic
		setStatus("recording");
	}, []);

	const startRecording = useCallback(async () => {
		try {
			setStatus("connecting");
			setError(null);
			setTranscript("");
			setLanguage(null);

			// 1. Get microphone permission first (so the user sees the prompt immediately)
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
			});
			streamRef.current = stream;

			// 2. Connect WebSocket to our Worker
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
								setError(
									err instanceof Error ? err.message : "Audio capture failed",
								);
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
							break;
						case "error":
							setError(data.message);
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

			// Wait for open
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true });
				ws.addEventListener("error", () => reject(new Error("Connection failed")), {
					once: true,
				});
			});

			// 3. Tell the server to connect to Mistral
			ws.send(JSON.stringify({ type: "start" }));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start recording");
			setStatus("idle");
			cleanup();
		}
	}, [cleanup, startAudioCapture, status]);

	const stopRecording = useCallback(() => {
		setStatus("stopping");
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "stop" }));
		}
		cleanup();
		setStatus("idle");
	}, [cleanup]);

	return (
		<div className="app">
			<header className="header">
				<h1>Live Transcription</h1>
				<p className="subtitle">
					Powered by Mistral Voxtral &amp; Cloudflare Workers
				</p>
			</header>

			{/* Transcript card */}
			<div className="transcript-card">
				<div className="corner tl" />
				<div className="corner tr" />
				<div className="corner bl" />
				<div className="corner br" />

				{language && (
					<div className="language-badge">
						{language}
					</div>
				)}

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
						Start Recording
					</button>
				) : status === "connecting" ? (
					<button className="btn-disabled" disabled>
						<span className="spinner" />
						Connecting…
					</button>
				) : (
					<button className="btn-stop" onClick={stopRecording}>
						<span className="stop-icon">■</span>
						Stop Recording
					</button>
				)}
			</div>

			{/* Copy button */}
			{transcript && status === "idle" && (
				<button
					className="btn-ghost"
					onClick={() => navigator.clipboard.writeText(transcript)}
				>
					Copy transcript
				</button>
			)}

			<footer className="footer">
				<code>voxtral-mini-transcribe-realtime-2602</code> · PCM S16LE 16 kHz
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
