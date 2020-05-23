const { Writable } = require('stream');
const util = require('util');
const int24 = require('int24');

class Input {
  constructor(args) {
    Writable.call(this, args);

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
}

util.inherits(Input, Writable);

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
