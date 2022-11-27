const { Readable } = require('stream');
const util = require('util');
const int24 = require('int24');
const Input = require('./input.js');

class Mixer {
  constructor(args) {
    Readable.call(this, args);

    if (typeof args === 'undefined') {
      args = {};
    }

    if (args.channels !== 1 && args.channels !== 2) {
      args.channels = 2;
    }

    if (typeof args.sampleRate === 'number' || args.sampleRate < 1) {
      args.sampleRate = 44100;
    }

    if (typeof args.chunkSize !== 'number' || args.chunkSize < 1) {
      args.chunkSize = 131072;
    }

    this.buffer = Buffer.alloc(0);
    this.bitDepth = args.bitDepth;

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
    this.sampleRate = args.sampleRate;
    this.chunkSize = args.chunkSize;
    this.inputs = [];

    this._sampleRoof = Math.pow(2, this.bitDepth - 1) - 1;
    this._sampleFloor = -this._sampleRoof - 1;
  }

  _read() {
    let samples = 0;

    if (this.inputs && this.inputs.length) {
      samples = this.inputs
        .map((input) => input.availSamples() || 0)
        .reduce((a, b) => Math.min(a, b));
    }

    if (this.chunkSize && this.chunkSize < samples) {
      samples = this.chunkSize;
    }

    if (samples) {
      const mixedBuffer = Buffer.alloc(
        samples * this.sampleByteLength * this.channels
      );

      mixedBuffer.fill(0);

      this.inputs.forEach((input) => {
        let inputBuffer;
        if (this.channels === 1) {
          inputBuffer = input.readMono(samples);
        } else {
          inputBuffer = input.readStereo(samples);
        }

        for (let i = 0; i < samples * this.channels; i++) {
          // volume adjusted input sample
          let inputSample = Math.round(
            (this.readSample.call(inputBuffer, i * this.sampleByteLength)
              * input.volume)
              / this.inputs.length
          );
          
          // Clamped output sample
          let outputSample = this.readSample.call(mixedBuffer, i * this.sampleByteLength) + inputSample;
          if (outputSample > this._sampleRoof) {
            outputSample = this._sampleRoof;
          }
          else if (outputSample < this._sampleFloor) {
            outputSample = this._sampleFloor;
          }

          this.writeSample.call(
            mixedBuffer,
            outputSample,
            i * this.sampleByteLength
          );

          input.calcLevel(inputSample)
        }
      });

      this.push(mixedBuffer);
    } else if (this.inputs && this.inputs.length) {
      setTimeout(this._read.bind(this), 20);
    }
  }

  input(args) {
    if (typeof args === 'undefined') {
      args = {};
    }

    const input = new Input({
      mixer: this,
      channels: args.channels || this.channels,
      bitDepth: args.bitDepth || this.bitDepth,
      sampleRate: args.sampleRate || this.sampleRate,
      chunkSize: this.chunkSize,
      volume: args.volume,
    });

    this.inputs.push(input);

    input.once('finish', () => {
      this.inputs.splice(this.inputs.indexOf(input), 1);
    });

    if (this.inputs.length === 1) {
      setImmediate(this._read.bind(this));
    }

    return input;
  }

  removeInput(input) {
    const index = this.inputs.indexOf(input);
    if (index > -1) this.inputs.splice(index, 1);
  }
}

util.inherits(Mixer, Readable);

module.exports = Mixer;
