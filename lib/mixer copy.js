const { Readable } = require('stream');
const util = require('util');
const int24 = require('int24');
const Input = require('./input.js');
const Level = require('./level.js');

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
      // args.chunkSize = 131072;
      args.chunkSize = 9000;
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
    this._minSamples = undefined;
    this.actSampleRate = this.sampleRate;
    this._sampleRateControl = 0;
    this._hrtime;
    this._sampleCounter = 0;
  }

  _read() {
    if (this.inputs) {
      let samples = 0;
      let minSampleRate;
      // Only use inputs with available samples (ignore dead inputs)
      // let inputs = this.inputs.filter(i => i.availSamples() > 0);
      let inputs = this.inputs;
      if (inputs.length) {
        // Minimum measured sample rate
        minSampleRate = inputs.map((input) => input.actSampleRate).reduce((a, b) => Math.min(a, b));


        // Dampened minimum available samples for all inputs
        // this._minSamples = inputs.map((input) => input.aveAvailSamples).reduce((a, b) => Math.min(a, b));
        this._minSamples = inputs.map((input) => input.availSamples()).reduce((a, b) => Math.min(a, b));
        // let maxSamples = inputs.map((input) => input.aveAvailSamples).reduce((a, b) => Math.max(a, b));
        // console.log(maxSamples - this._minSamples);
        // if (!this._minSamples) {
        //   this._minSamples = m;
        // } else {
        //   // this._minSamples += (m - this._minSamples) / 1000;
        //   this._minSamples = m;
        // }
        // console.log(Math.round(this._minSamples) + '  ' + m);


        samples = inputs.map((input) => input.availSamples() || 0).reduce((a, b) => Math.min(a, b));
      }

      // if (inputs.length > 1) {
      //   let minSampleRate = inputs.map((input) => input.actSampleRate).reduce((a, b) => Math.min(a, b));
      //   let maxSampleRate = inputs.map((input) => input.actSampleRate).reduce((a, b) => Math.max(a, b));
      //   console.log(maxSampleRate - minSampleRate);
      // }
      // let minSamples = inputs.map(input => input.averageSamples).reduce((a, b) => Math.min(a, b));

      // calculate average samples per input
      // inputs.forEach(input => {
      //   if (input.averageSamples != 0) {
      //     input.averageSamples += (input.availSamples() - input.averageSamples) / 1000000
      //   } else {
      //     input.averageSamples = input.availSamples();
      //   }
      //   let min = inputs.map(input => input.averageSamples).reduce((a, b) => Math.min(a, b));
      //   if (this._minSamples != 0) {
      //     this._minSamples += (min - this._minSamples) / 1000
      //   } else {
      //     this._minSamples = min;
      //   }
      // });


      if (this.chunkSize && this.chunkSize < samples) {
        samples = this.chunkSize;
      }

      if (samples) {
        // Output sample rate controller: Insert duplicated samples to increase sample rate
        this._sampleRateControl += (this.sampleRate - this.actSampleRate) / 10000;
        // let sampleRateControl = Math.floor(Math.pow(Math.abs(this._sampleRateControl), 2)*Math.abs(this._sampleRateControl)/this._sampleRateControl);
        let sampleRateControl = 0;
        let firstInsert = Math.floor((samples - (this.sampleRate/sampleRateControl - this._sampleCounter)));
        let insertSamples = 0;
        // if (firstInsert >= 0) {
        //   insertSamples = Math.floor(sampleRateControl * samples / (this.sampleRate - sampleRateControl));
        // }

        const mixedBuffer = Buffer.alloc(
          (samples + insertSamples) * this.sampleByteLength * this.channels
        );

        mixedBuffer.fill(0);

        for (let j = 0; j < inputs.length; j++) {
          let input = inputs[j];
          let last = j == inputs.length - 1;

          // Available samples measurement
          input.aveAvailSamples += (input.availSamples() - input.aveAvailSamples) / 10000

          // Input buffer controller
          let lag = input.availSamples() - this._minSamples;
          input.bufferControl += lag / 10000;
          let bufferControl = Math.pow(input.bufferControl, 2)
          // let bufferControl = 0;

          // console.log(bufferControl);

          // console.log(input.aveAvailSamples);

          // let diff = samples - input.availSamples();
          // console.log(diff);

          // Get input average samples
          // let d = input.averageSamples - this._minSamples;
          // let inputSamples = Math.max(Math.min(Math.round(input.averageSamples), input.availSamples()), samples);
          // let diff = inputSamples - samples;

          // Calculate additional input samples to be read
          // let firstDrop = Math.floor((samples - (input.actSampleRate - input.sampleCounter)));
          // let additionalSamples = 0;
          // if (input.sampleRateAdj >= 1 && firstDrop >= 0) {
          //   // additionalSamples * input.actSampleRate = input.sampleRateAdj * (samples + additionalSamples)
          //   // additionalSamples * input.actSampleRate = input.sampleRateAdj * samples + input.sampleRateAdj * additionalSamples
          //   // additionalSamples * input.actSampleRate - input.sampleRateAdj * additionalSamples = input.sampleRateAdj * samples
          //   // additionalSamples * (input.actSampleRate - input.sampleRateAdj) = input.sampleRateAdj * samples
          //   additionalSamples = Math.floor(input.sampleRateAdj * samples / (input.actSampleRate - input.sampleRateAdj));
          // }
          let firstDrop = Math.floor((samples - (input.sampleRate/bufferControl - input.sampleCounter)));
          let additionalSamples = 0;
          if (bufferControl >= 1 && firstDrop >= 0) {
            // additionalSamples * input.actSampleRate = input.sampleRateAdj * (samples + additionalSamples)
            // additionalSamples * input.actSampleRate = input.sampleRateAdj * samples + input.sampleRateAdj * additionalSamples
            // additionalSamples * input.actSampleRate - input.sampleRateAdj * additionalSamples = input.sampleRateAdj * samples
            // additionalSamples * (input.actSampleRate - input.sampleRateAdj) = input.sampleRateAdj * samples
            additionalSamples = Math.floor(bufferControl * samples / (input.sampleRate - bufferControl));
          }
          // additionalSamples = Math.floor((samples - (input.actSampleRate - input.sampleCounter))); //+ (samples)/(input.actSampleRate - input.sampleRateAdj))
          if (additionalSamples < 0) additionalSamples = 0;
          let a = input.availSamples();
          if (a < samples + additionalSamples) additionalSamples = a - samples;

          let inputSamples = samples + additionalSamples;
          // if (additionalSamples > 0) console.log(additionalSamples);

          let inputBuffer;
          if (this.channels === 1) {
            inputBuffer = input.readMono(inputSamples);
          } else {
            inputBuffer = input.readStereo(inputSamples);
          }

          // let skipRate = 0;
          // let skipNext = inputSamples;
          // if (diff > 0) {
          //   skipRate = inputSamples / diff;
          //   skipNext = skipRate;
          // }

          let processed = 0;
          let sampleCounterDone = false;
          for (let i = 0; i < inputSamples * this.channels; i++) {
            // Drop samples to adjust input buffers
            // if (input.sampleCounter >= input.actSampleRate - input.sampleRateAdj) {
            //   if (input.sampleRateAdj >= 1 && i < inputSamples * this.channels - this.channels) {
            //     i += this.channels;
            //     input.sampleCounter = 0;
            //   } 
            // }
            if (input.sampleCounter >= input.sampleRate - bufferControl) {
              if (bufferControl >= 1 && i < inputSamples * this.channels - this.channels) {
                i += this.channels;
                input.sampleCounter = 0;
              }
            }
            else {
              input.sampleCounter += 1 / this.channels;
            }

            // Insert samples adjust output sample rate
            // if (this._sampleCounter >= this.sampleRate - sampleRateControl) {
            //   if (sampleRateControl >= 1) {
            //     i -= this.channels;
            //   } else {
            //     i += this.channels;
            //   }
            //   sampleCounterDone = true;
            // }

            if (processed < samples) {
              // volume adjusted input sample
              let inputSample = Math.round(
                (this.readSample.call(inputBuffer, i * this.sampleByteLength)
                  * input.volume)
                / inputs.length
              );

              // Clamped output sample
              let outputSample = this.readSample.call(mixedBuffer, processed * this.sampleByteLength) + inputSample * this.volume;
              if (outputSample > this._sampleRoof) {
                outputSample = this._sampleRoof;
              }
              else if (outputSample < this._sampleFloor) {
                outputSample = this._sampleFloor;
              }

              this.writeSample.call(
                mixedBuffer,
                outputSample,
                processed * this.sampleByteLength
              );

              // Calculate level indications
              input.level.calc(inputSample);
              if (last) {
                this.level.calc(outputSample);
              }
            }

            processed++;
          }

          this._sampleCounter += 1 / this.channels;
          if (sampleCounterDone) this._sampleCounter = 0;

          // sample rate controller, using the minSampleRate as reference
          input.sampleRateAdj += (input.actSampleRate - minSampleRate) / 10000;

          // Sample rate controller using the minimum samples as a reference. Controller output = number of samples to be dropped per sampleRate samples
          // bufferControl += (input.aveAvailSamples - this._minSamples) / 10000;

          // calculate actual sample rate
          let s = processed / this.channels / this._hrtimeDiff();
          if (s) {
            // dampening
            this.actSampleRate += (s - this.actSampleRate) / 5000000;
          }
          console.log(this.actSampleRate);
        }

        this.push(mixedBuffer);

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

  _hrtimeDiff() {
    if (this._hrtime) {
      let t = process.hrtime();
      let o = (t[0] - this._hrtime[0] + (t[1] - this._hrtime[1]) / 100000000);
      this._hrtime = t;
      return o;
    } else {
      this._hrtime = process.hrtime();
      return undefined;
    }
  }
}

util.inherits(Mixer, Readable);

module.exports = Mixer;
