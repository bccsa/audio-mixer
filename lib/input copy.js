const { Writable } = require('stream');
const int24 = require('int24');
const Level = require('./level.js');
const { threadId } = require('worker_threads');

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

    // this._hrtime;
    // this.actSampleRate = this.sampleRate; // measured sample rate
    // this._srDampFactor = 5000000; // Sample rate measurement damping factor (higher number -> more dampening)
    // this.sampleRateAdj = 0; // Sample rate adjustment number (samples per second)
    this._dropCounter = 0; // Sample drop counter
    this.aveAvailSamples = this.chunkSize;
    this._bufferCV = 0;
    this._dropInterval = undefined;
  }

  /**
   * Samples to be dropped per second by buffer control (control variable)
   */
  get bufferCV() {
    return this._bufferCV;
  }

  /**
   * Samples to be dropped per second by buffer control (control variable)
   */
  set bufferCV(val) {
    if (val != this._bufferCV) {
      this._bufferCV = val;
      this._dropInterval = Math.round(this.sampleRate / this.bufferCV);
      if (this._dropInterval && !this._dropCounter) {
        this._dropCounter = this._dropInterval;
      };
    }
  }

  read(samples) {
    // Return buffer with dropped samples
    if (this._dropCounter && this._dropCounter <= samples) {
      let addSamples = Math.floor(((samples - 1) / this._dropInterval + 1) / (1 - 1 / this._dropInterval));

      const r = Buffer.alloc(samples * this.sampleSize);
      let readSamples = samples + addSamples;
      let p = 0; // processed samples count
      for (let i = 0; i < readSamples; i++) {

        // Drop samples when drop sample counter is 0
        if (this._dropCounter == 0) {
          this._dropCounter = this._dropInterval;
          i++;
        }
        this._dropCounter--;

        // Copy data to read buffer.
        if (i < readSamples) {
          for (let j = 0; j < this.sampleSize; j++) {
            r[(p * this.sampleSize + j)] = this.buffer[(i * this.sampleSize + j)];
          }
        }
        else {
          console.log('check')
        }
        p++;
      }
      // Clear internal buffer
      this.buffer = this.buffer.slice(readSamples * this.sampleSize);
      return r;
    }
    // Return buffer without dropped samples
    else {
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

      // Decrement drop counter by sample size
      if (this._dropCounter) {
        this._dropCounter -= samples
      }
      return r;
    }
  }

  /**
   * Available samples excluding samples to be dropped by input buffer control
   */
  availSamples2() {
    let availSamples = this.availSamples();

    if (this._dropCounter && this._dropCounter < availSamples) {
      availSamples -= Math.floor(((availSamples - 1) / this._dropInterval + 1) / (1 - 1 / this._dropInterval));
    }

    return availSamples;
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

    // calculate sample rate
    // let s = chunk.length / this.sampleByteLength / this.channels / this._hrtimeDiff();
    // if (s) {
    //   // dampening
    //   this.actSampleRate += (s - this.actSampleRate) / this._srDampFactor;
    // }

    if (this.buffer.length > this.chunkSize * 2) {
      this.getMoreData = next;
    } else {
      next();
    }
  }

  // _hrtimeDiff() {
  //   if (this._hrtime) {
  //     let t = process.hrtime();
  //     let o = (t[0] - this._hrtime[0] + (t[1] - this._hrtime[1]) / 100000000);
  //     this._hrtime = t;
  //     return o;
  //   } else {
  //     this._hrtime = process.hrtime();
  //     return undefined;
  //   }
  // }
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
