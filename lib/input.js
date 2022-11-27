const { Writable } = require('stream');
const int24 = require('int24');
const events = require('events');

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
    this.volume = args.volume;
    this.getMoreData = null;
    this._level = 0;
    this._peak = 0;

    this._sampleRoof = Math.pow(2, this.bitDepth - 1) - 1;
    this._sampleFloor = -this._sampleRoof - 1;

    this._peak1000th = new peakBuffer(this.sampleRate, 1 / 1000);
    this._peak100th = new peakBuffer(this._peak1000th.outputSampleRate, 1 / 100)
    this._peak5th = new peakBuffer(this._peak100th.outputSampleRate, 1 / 5);
    this._peak3 = new peakBuffer(this._peak5th.outputSampleRate, 3);

    this._peak1000th.onPeakUpdate(peak => {
      this._peak100th.setLevel(peak);
    });
    this._peak100th.onPeakUpdate(peak => {
      this._peak5th.setLevel(peak);
    });
    this._peak5th.onPeakUpdate(peak => {
      this._level = peak / this._sampleRoof; // Convert from int16/25/32 level to factor of 1.
      this._events.emit('level', this._level);
      this._peak3.setLevel(this._level);
      // Update 3-sec peak every 1/10 seconds to give moving peak
      this._peak = this._peak3.getPeak();
      this._events.emit('peak', this._peak);
    });

    this._events = new events();
  }

  read(samples) {
    let bytes = samples * (this.bitDepth / 8) * this.channels;

    if (this.buffer.length < bytes) {
      bytes = this.buffer.length;
    }

    const r = this.buffer.slice(0, bytes);
    this.buffer = this.buffer.slice(bytes);

    if (this.buffer.length <= this.chunkSize * 2 && this.getMoreData !== null) {
      const { getMoreData } = this;
      this.getMoreData = null;
      process.nextTick(getMoreData);
    }

    return r;
  }

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
  }

  /**
   * Subscribe to audio mixer input events
   * @param {*} eventName - Implemented event names are 'level' and 'peak'
   * @param {*} listener - callback function
   */
  on(eventName, listener) {
    return this._events.on(eventName, listener);
  }

  /**
   * Get the current audio level
   */
  get level() {
    return this._level;
  }

  /**
   * Calculate the short and long term peaks. This function is called by mixer.js
   */
  calcLevel(sample) {
    this._peak1000th.setLevel(Math.abs(sample));
  }

  /**
   * Get the 3s audio peak
   */
  get peak() {
    return this._peak;
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

class peakBuffer {
  constructor(sampleRate, peakLength) {
    this._peakArr = new Array(Math.round(sampleRate * peakLength));
    this._peakArr.fill(0);
    this._peakIndex = 0;
    this._callbacks = [];
    this.outputSampleRate = 1 / peakLength;
  }

  onPeakUpdate(callback) {
    if (typeof callback === 'function') {
      this._callbacks.push(callback);
    }
  }

  setLevel(level) {
    this._peakArr[this._peakIndex] = level;
    this._peakIndex++;
    if (this._peakIndex == this._peakArr.length) {
      this._peakIndex = 0;
      // execute callbacks and pass peakLevel
      if (this._callbacks.length > 0) {
        let peakLevel = this.getPeak();
        this._callbacks.forEach(c => {
          c(peakLevel);
        });
      }
    }
  }

  getPeak() {
    return Math.max(...this._peakArr);
  }
}

module.exports = Input;
