/**
 * AudioWorklet processor that captures microphone audio, resamples to 16 kHz,
 * converts Float32 → Int16 (PCM S16LE), and posts binary chunks to the main thread.
 *
 * The processor buffers samples and emits ~100 ms chunks (1 600 samples at 16 kHz).
 */
class PCMProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this._targetRate = 16000;
		this._ratio = this._targetRate / sampleRate;
		this._chunkSamples = Math.floor(this._targetRate * 0.1); // 100 ms
		// Pre-allocate a ring buffer (1 s of audio at target rate)
		this._bufSize = this._targetRate;
		this._buf = new Float32Array(this._bufSize);
		this._writePos = 0;
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || !input[0] || input[0].length === 0) return true;

		const raw = input[0]; // mono channel

		// Resample into the internal buffer
		if (Math.abs(sampleRate - this._targetRate) < 1) {
			// No resampling needed
			if (this._writePos + raw.length > this._bufSize) this._flush();
			this._buf.set(raw, this._writePos);
			this._writePos += raw.length;
		} else {
			const outLen = Math.round(raw.length * this._ratio);
			if (this._writePos + outLen > this._bufSize) this._flush();
			for (let i = 0; i < outLen; i++) {
				const srcIdx = i / this._ratio;
				const lo = Math.floor(srcIdx);
				const hi = Math.min(lo + 1, raw.length - 1);
				const t = srcIdx - lo;
				this._buf[this._writePos + i] =
					raw[lo] + t * (raw[hi] - raw[lo]);
			}
			this._writePos += outLen;
		}

		// Emit full chunks
		while (this._writePos >= this._chunkSamples) {
			const pcm = new Int16Array(this._chunkSamples);
			for (let i = 0; i < this._chunkSamples; i++) {
				const s = Math.max(-1, Math.min(1, this._buf[i]));
				pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
			}
			this.port.postMessage(pcm.buffer, [pcm.buffer]);

			// Shift remaining data forward
			const remaining = this._writePos - this._chunkSamples;
			if (remaining > 0) {
				this._buf.copyWithin(0, this._chunkSamples, this._writePos);
			}
			this._writePos = remaining;
		}

		return true;
	}

	/** Force-emit whatever is currently in the buffer (partial chunk). */
	_flush() {
		if (this._writePos > 0) {
			const pcm = new Int16Array(this._writePos);
			for (let i = 0; i < this._writePos; i++) {
				const s = Math.max(-1, Math.min(1, this._buf[i]));
				pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
			}
			this.port.postMessage(pcm.buffer, [pcm.buffer]);
			this._writePos = 0;
		}
	}
}

registerProcessor("pcm-processor", PCMProcessor);
