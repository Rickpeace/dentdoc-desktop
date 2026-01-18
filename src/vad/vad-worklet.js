/**
 * VAD AudioWorklet Processor
 *
 * Runs in AudioWorklet thread (separate from main thread).
 * Collects audio frames and batches them before sending to VAD Worker.
 *
 * IMPORTANT:
 * - This file runs in AudioWorklet scope, NOT Node.js
 * - Cannot use require() or Node modules
 * - Communicates via port.postMessage()
 *
 * Usage:
 *   await audioContext.audioWorklet.addModule('vad-worklet.js');
 *   const vadNode = new AudioWorkletNode(audioContext, 'vad-processor');
 */

class VADProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Configuration from options or defaults
    const config = options.processorOptions || {};
    this.sampleRate = config.sampleRate || 16000;
    this.frameMs = config.frameMs || 20;
    this.batchFrames = config.batchFrames || 5;

    // Calculate sizes
    this.samplesPerFrame = Math.floor(this.sampleRate * this.frameMs / 1000); // 320
    this.samplesPerBatch = this.samplesPerFrame * this.batchFrames; // 1600

    // Buffer to accumulate samples
    this.buffer = new Float32Array(this.samplesPerBatch);
    this.bufferIndex = 0;

    // Running state
    this.isActive = true;

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this.isActive = false;
      } else if (event.data.type === 'start') {
        this.isActive = true;
        this.bufferIndex = 0;
      }
    };
  }

  /**
   * Process audio data.
   * Called for each 128-sample render quantum (~2.67ms at 48kHz, ~8ms at 16kHz).
   *
   * @param {Float32Array[][]} inputs - Input audio data
   * @param {Float32Array[][]} outputs - Output audio data (passthrough)
   * @param {Object} parameters - AudioParam values
   * @returns {boolean} - Return true to keep processor alive
   */
  process(inputs, outputs, parameters) {
    // Check if we have input
    const input = inputs[0];
    if (!input || !input.length || !this.isActive) {
      return true;
    }

    // Get mono channel (first channel)
    const channelData = input[0];
    if (!channelData || !channelData.length) {
      return true;
    }

    // Copy samples to buffer
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      // When buffer is full, send batch to worker
      if (this.bufferIndex >= this.samplesPerBatch) {
        // Send copy of buffer
        const batch = new Float32Array(this.buffer);
        this.port.postMessage({
          type: 'audio-batch',
          samples: batch,
          timestamp: currentTime
        });

        // Debug: log batch size occasionally (every 10th batch = ~1 second)
        this.batchCount = (this.batchCount || 0) + 1;
        if (this.batchCount % 10 === 1) {
          this.port.postMessage({ type: 'debug', batchSize: batch.length, batchCount: this.batchCount });
        }

        // Reset buffer index (keep buffer for reuse)
        this.bufferIndex = 0;
      }
    }

    // Passthrough audio (optional, for monitoring)
    // for (let channel = 0; channel < outputs[0].length; channel++) {
    //   outputs[0][channel].set(inputs[0][channel]);
    // }

    return true;
  }
}

// Register the processor
registerProcessor('vad-processor', VADProcessor);
