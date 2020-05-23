const fs = require('fs');
const Speaker = require('speaker');

const lame = require('lame');
const Mixer = require('../index.js');


/*
 * Create the mixer and stream to speaker:
 */

const mixer = new Mixer({
  channels: 1
});

const speaker = new Speaker({
  channels: 1,
  bitDepth: 16,
  sampleRate: 44100
});

mixer.pipe(speaker);

/*
 * Decode mp3 and add the stream as mixer input:
 */

const file0 = fs.createReadStream('example0.mp3');

const decoder0 = new lame.Decoder();
const mp3stream0 = file0.pipe(decoder0);

decoder0.on('format', (format) => {
  console.log(format);

  mp3stream0.pipe(mixer.input({
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitDepth: format.bitDepth
  }));
});

/*
 * Decode mp3 and add the stream as mixer input:
 */

const file1 = fs.createReadStream('example1.mp3');

const decoder1 = new lame.Decoder();
const mp3stream1 = file1.pipe(decoder1);

decoder1.on('format', (format) => {
  console.log(format);

  mp3stream1.pipe(mixer.input({
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitDepth: format.bitDepth
  }));
});
