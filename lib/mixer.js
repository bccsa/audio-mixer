const { Readable } = require('stream');
const util = require('util');
const int24 = require('int24');
const Input = require('./input.js');
const Level = require('./level.js');
const { dampener, rate, piController } = require('./control.js');

class Mixer {
  constructor(args) {
    Readable.call(this, args);

    if (typeof args === 'undefined') {
      args = {};
    }

    if (args.channels !== 1 && args.channels !== 2) {
      args.channels = 2;
    }

    if (typeof args.sampleRate !== 'number' || args.sampleRate < 1) {
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

    if (!args.volume || typeof args.volume !== 'number') {
      args.volume = 1;
    }

    this.channels = args.channels;
    this.sampleRate = args.sampleRate;
    this.chunkSize = args.chunkSize;
    this.volume = args.volume;
    this.inputs = [];

    this._sampleRoof = Math.pow(2, this.bitDepth - 1) - 1;
    this._sampleFloor = -this._sampleRoof - 1;

    this.level = new Level(this.bitDepth, this.sampleRate);
    this._bufferSP = new dampener(1);

    // Sample rate measurement
    this._sampleRate = new rate(10, this.sampleRate);

    // Sample rate controller
    this._srController = new piController();
    this._srController.sp = this.sampleRate;
    this._srController.p = 0.5;
    this._srController.i = 0.05;
    this._srController.mincv = 0;
    this._srController.maxcv = this.sampleRate / 10;

    this._insertCounter = 0; // Sample drop counter
    this._insertInterval = undefined;
  }

  _read() {
    let samples = 0;
    let minSamples = 0;

    if (this.inputs) {
      // Ignore dead inputs
      let inputs = this.inputs.filter(i => !i.dead);

      if (inputs.length) {
        samples = inputs
          .map((input) => input.availSamples2() || 0)
          .reduce((a, b) => Math.min(a, b));

        // Buffer control set-point
        minSamples = inputs.map(input => input.availSamples() || 0).reduce((a, b) => Math.min(a, b));
        if (inputs.length > 1) {
          let maxSamples = inputs.map(input => input.availSamples() || 0).reduce((a, b) => Math.min(a, b));
        }
        
      }

      if (this.chunkSize && this.chunkSize < samples) {
        samples = this.chunkSize;
      }

      if (minSamples < 1024) {
        minSamples = 1024;
      }

      // dampened buffer controller(s) input
      this._bufferSP.in = minSamples;

      if (samples > 0) {
        // sample rate controller feedback
        this._srController.pv = this._sampleRate.rate;

        // calculate interval for samples to be dropped
        let cv = this._srController.cv;
        this._insertInterval = Math.round(this.sampleRate / cv);

        if (this._insertInterval && !this._insertCounter) {
          this._insertCounter = this._insertInterval;
        }

        let addSamples = 0
        if (this._insertCounter && this._insertCounter <= samples) {
          addSamples = Math.floor((samples - this._insertCounter) / (this._insertInterval - 1))
        }

        console.log(this._sampleRate.rate + "    " + cv);

        const mixedBuffer = Buffer.alloc(
          (samples + addSamples) * this.sampleByteLength * this.channels
        );

        mixedBuffer.fill(0);

        for (let j = 0; j < inputs.length; j++) {
          let input = inputs[j];
          let last = j == inputs.length - 1;
          input.bufferSP = this._bufferSP.out;

          let inputBuffer;
          if (this.channels === 1) {
            inputBuffer = input.readMono(samples);
          } else {
            inputBuffer = input.readStereo(samples);
          }

          let p = 0; // processed samples count;
          for (let i = 0; i < samples * this.channels; i++) {
            // volume adjusted input sample
            let inputSample = Math.round(
              (this.readSample.call(inputBuffer, i * this.sampleByteLength)
                * input.volume)
              / inputs.length
            );

            // Clamped output sample
            let outputSample = this.readSample.call(mixedBuffer, p * this.sampleByteLength) + inputSample * this.volume;
            if (outputSample > this._sampleRoof) {
              outputSample = this._sampleRoof;
            }
            else if (outputSample < this._sampleFloor) {
              outputSample = this._sampleFloor;
            }

            this.writeSample.call(
              mixedBuffer,
              outputSample,
              p * this.sampleByteLength
            );

            // Calculate level indications
            input.level.calc(inputSample);
            if (last) {
              this.level.calc(outputSample);
            }

            // Insert samples when insert sample counter is 0
            if (cv > 0) {
              if (this._insertCounter <= 0 && i >= this.channels) {
                this._insertCounter = this._insertInterval;
                i-= this.channels;
              }
              this._insertCounter--;
            }
            
            p++;
          }
        }

        this.push(mixedBuffer);

        this._sampleRate.samples = samples;

      } else if (this.inputs && this.inputs.length) {
        setTimeout(this._read.bind(this), 20);
      }
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
