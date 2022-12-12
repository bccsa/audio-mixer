const { Writable } = require('stream');
const int24 = require('int24');
const Level = require('./level.js');
const { piController, dampener } = require('./control.js');

class Input extends Writable {
  constructor(args) {
    super(args)

    if (!args) {
      args = {};
    }

    if (args.channels !== 1 && args.channels !== 2) {
      args.channels = 2;
    }

    if (typeof args.sampleRate !== 'number' || args.sampleRate < 1) {
      args.sampleRate = 44100;
    }

    if (typeof args.volume !== 'number' || args.volume < 0) {
      args.volume = 1;
    }

    this.buffer = Buffer.alloc(0);

    if (args.channels === 1) {
      this.readMono = this.read;
    }

    if (args.channels === 2) {
      this.readStereo = this.read;
    }

    if (args.bitDepth === 8) {
      this.readSample = this.buffer.readInt8;
      this.writeSample = this.buffer.writeInt8;
      this.sampleByteLength = 1;
    } else if (args.bitDepth === 32) {
      this.readSample = this.buffer.readInt32LE;
      this.writeSample = this.buffer.writeInt32LE;
      this.sampleByteLength = 4;
    } else if (args.bitDepth === 24) {
      this.readSample = (offset) => int24.readInt24LE(this.buffer, offset);
      this.writeSample = (offset, value) => {
        int24.writeInt24LE(this.buffer, offset, value);
      };
      this.sampleByteLength = 3;
    } else {
      args.bitDepth = 16;
      this.readSample = this.buffer.readInt16LE;
      this.writeSample = this.buffer.writeInt16LE;
      this.sampleByteLength = 2;
    }

    this.channels = args.channels;
    this.bitDepth = args.bitDepth;
    this.sampleRate = args.sampleRate;
    this.chunkSize = args.chunkSize;
    this.sampleSize = this.sampleByteLength * this.channels;
    this.volume = args.volume;
    this.getMoreData = null;

    this.level = new Level(this.bitDepth, this.sampleRate);

    this._dropCounter = 0; // Sample drop counter
    this._dropInterval = undefined;

    this._bufferController = new piController();
    this._bufferController.p = 0.5;
    this._bufferController.i = 0.05;
    this._bufferController.invert = true;
    this._bufferController.mincv = 0;
    this._bufferController.maxcv = this.sampleRate / 10;

    this._availSamplesDampener = new dampener(1);

    this._deadInputTimer;
    this.dead = true;
  }

  /**
   * Buffer size set-point
   */
  get bufferSP() {
    return this._bufferController.sp;
  }

  /**
   * Buffer size set-point
   */
  set bufferSP(sp) {
    this._bufferController.sp = sp;
  }

  read(samples) {
    // Dampen PI controller PV input
    this._availSamplesDampener.in = this.availSamples();
    // Buffer controller  
    this._bufferController.pv = this._availSamplesDampener.out;
    let cv = this._bufferController.cv;
    let r;

    let addSamples = Math.ceil((samples - this._dropCounter) / (this._dropInterval - 1))
    let readSamples = samples + addSamples;

    // Return buffer with dropped samples
    let p = 0; // processed samples count
    if (typeof this._dropCounter === 'number' && this._dropCounter <= readSamples) {
      r = Buffer.alloc(samples * this.sampleSize);
      // let readSamples = samples + addSamples;
      for (let i = 0; i < readSamples; i++) {
        // Copy data to read buffer.
        for (let j = 0; j < this.sampleSize; j++) {
          r[(p * this.sampleSize + j)] = this.buffer[(i * this.sampleSize + j)];
        }

        // Drop samples when drop sample counter is 0
        if (cv > 0) {
          if (this._dropCounter == 0) {
            this._dropCounter = this._dropInterval;
            i++;
          }
          this._dropCounter--;
        }

        p++;
      }
      // Clear internal buffer
      this.buffer = this.buffer.slice(readSamples * this.sampleSize);
    }
    // Return buffer without dropped samples
    else {
      let bytes = samples * (this.bitDepth / 8) * this.channels;

      if (this.buffer.length < bytes) {
        bytes = this.buffer.length;
      }

      r = this.buffer.slice(0, bytes);
      this.buffer = this.buffer.slice(bytes);

      if (this.buffer.length <= this.chunkSize * 2 && this.getMoreData !== null) {
        const { getMoreData } = this;
        this.getMoreData = null;
        process.nextTick(getMoreData);
      }

      // Decrement drop counter by sample size
      if (this._dropCounter) {
        this._dropCounter -= samples
      }
    }

    // calculate interval for samples to be dropped
    this._dropInterval = Math.round(this.sampleRate / cv);
    if (this._dropInterval && !this._dropCounter) {
      this._dropCounter = this._dropInterval;
    }

    return r;
  }

  /**
   * Available samples excluding samples to be dropped by input buffer control
   */
  availSamples2() {
    let availSamples = this.availSamples();
    let addSamples = Math.floor((availSamples - this._dropCounter) / (this._dropInterval - 1));
    if (addSamples && addSamples > 0) {
      availSamples -= addSamples;
    }

    return Math.max(availSamples, 0);
  }

  /**
   * Available samples
   * @param {Number} length - optional length
   * @returns 
   */
  availSamples(length) {
    if (typeof length === 'undefined') {
      length = this.buffer.length;
    }
    return Math.floor(length / ((this.bitDepth / 8) * this.channels));
  }

  _write(chunk, encoding, next) {
    this.buffer = Buffer.concat([this.buffer, chunk]);


    if (this.buffer.length > this.chunkSize * 2) {
      this.getMoreData = next;
    } else {
      next();
    }

    this.dead = false;
    if (this._deadInputTimer) {
      clearTimeout(this._deadInputTimer);
    }

    // Set input dead flag if no data is written for 100ms.
    this._deadInputTimer = setTimeout(() => {
      this.dead = true;
    }, 50);
  }
}

// This function will be overridden by this.read, if input already is mono.
Input.prototype.readMono = (samples) => {
  const stereoBuffer = this.read(samples);
  const monoBuffer = Buffer.alloc(stereoBuffer.length / 2);
  const s = this.availSamples(stereoBuffer.length);

  for (let i = 0; i < s; i++) {
    const l = this.readSample.call(stereoBuffer, i * this.sampleByteLength * 2);
    const r = this.readSample.call(
      stereoBuffer,
      i * this.sampleByteLength * 2 + this.sampleByteLength
    );
    this.writeSample.call(
      monoBuffer,
      Math.round((l + r) / 2),
      i * this.sampleByteLength
    );
  }

  return monoBuffer;
};

// This function will be overridden by this.read, if input already is stereo.
Input.prototype.readStereo = (samples) => {
  const monoBuffer = this.read(samples);
  const stereoBuffer = Buffer.alloc(monoBuffer.length * 2);
  const s = this.availSamples(monoBuffer.length);

  for (let i = 0; i < s; i++) {
    const m = this.readSample.call(monoBuffer, i * this.sampleByteLength);
    this.writeSample.call(stereoBuffer, m, i * this.sampleByteLength * 2);
    this.writeSample.call(
      stereoBuffer,
      m,
      i * this.sampleByteLength * 2 + this.sampleByteLength
    );
  }

  return stereoBuffer;
};

module.exports = Input;
