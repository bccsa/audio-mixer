# audio-mixer

Node.js module for mixing multiple PCM streams into one.

## Install

```
npm install @rophil/audio-mixer
```

## Usage

```js
const Mixer = require('@rophil/audio-mixer');

// ...

// Create audio mixer
const mixer = new Mixer({
  channels: 2,
  bitDepth: 16,
  clearInterval: 250,
  sampleRate: 48000,
});

// Create mixer inputs
const input0 = mixer.input({
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
  volume: 0.5
});

const input1 = mixer.input({
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
  volume: 0.7
});

// Pipe your PCM streams into the mixer inputs
pcmStream0.pipe(input0);
pcmStream1.pipe(input1);

// Get level and peak indications (range = 0 to 1)
input0.level.on('level', level => {
  // Do something with input0's instantaneous level indication
});

input1.level.on('peak', level => {
  // Do something with input1's 3s peak level indication
});

mixer.level.on('level', level => {
  // Do something with the mixer instantaneous output level indication
});
```

## Credits

The accordionist in example0.mp3 and example1.mp3 is Halvard, the grandpa of the orignal package author.

