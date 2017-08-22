var
	Readable = require('stream').Readable,
	util = require('util'),
	int24 = require('int24'),
	Input = require('./input.js')
	;

function Mixer(args) {
	Readable.call(this, args);

	if (typeof args === 'undefined') args = {};
	if (args.channels != 1 && args.channels != 2) args.channels = 2;
	if (typeof args.sampleRate === 'number' || args.sampleRate < 1) args.sampleRate = 44100;
	if (typeof args.chunkSize !== 'number' || args.chunkSize < 1) args.chunkSize = 131072;

	this.buffer = new Buffer(0);

	this.bitDepth = args.bitDepth;
	if (args.bitDepth == 8) {
		this.readSample = this.buffer.readInt8;
		this.writeSample = this.buffer.writeInt8;
		this.sampleByteLength = 1;
	}
	else if (args.bitDepth == 32) {
		this.readSample = this.buffer.readInt32LE;
		this.writeSample = this.buffer.writeInt32LE;
		this.sampleByteLength = 4;
	}
	else if (args.bitDepth == 24) {
		this.readSample = function (offset) {
			return int24.readInt24LE(this.buffer, offset);
		};
		this.writeSample = function (offset, value) {
			int24.writeInt24LE(this.buffer, offset, value);
		};
		this.sampleByteLength = 3;
	}
	else {
		args.bitDepth = 16;
		this.readSample = this.buffer.readInt16LE;
		this.writeSample = this.buffer.writeInt16LE;
		this.sampleByteLength = 2;
	}

	this.channels = args.channels;
	this.sampleRate = args.sampleRate;
	this.chunkSize = args.chunkSize;

	this.inputs = [];
}

util.inherits(Mixer, Readable);

Mixer.prototype._read = function() {

	var samples = 0;

	if (this.inputs.length){
		samples = this.inputs.map(function (input) {
			return input.availSamples() || 0;
		}).reduce(function(a,b){
			return Math.min(a,b);
		});
	}

	if (this.chunkSize && this.chunkSize < samples) samples = this.chunkSize;

	if (samples) {

		var mixedBuffer = new Buffer(samples * this.sampleByteLength * this.channels);
		mixedBuffer.fill(0);
		this.inputs.forEach(function (input) {
			if (this.channels == 1) {
				var inputBuffer = input.readMono(samples);
			} else {
				var inputBuffer = input.readStereo(samples);
			}
			for (var i = 0; i < samples * this.channels; i++) {
				this.writeSample.call(mixedBuffer, this.readSample.call(mixedBuffer, i * this.sampleByteLength) + Math.round(this.readSample.call(inputBuffer, i * this.sampleByteLength) * input.volume / this.inputs.length), i * this.sampleByteLength);
			}
		}.bind(this));

		this.push(mixedBuffer);
	} else {
		if (this.inputs.length){
			setImmediate(this._read.bind(this));
		}
	}
};

Mixer.prototype.input = function (args) {
	if (typeof args === 'undefined') args = {};

	var input = new Input({
		mixer: this,
		channels: args.channels || this.channels,
		bitDepth: args.bitDepth || this.bitDepth,
		sampleRate: args.sampleRate || this.sampleRate,
		chunkSize: this.chunkSize,
		volume: args.volume
	});
	this.inputs.push(input);

	input.on('finish', () =>{
		this.inputs.splice(this.inputs.indexOf(input), 1);
	});

	if (this.inputs.length === 1){
		setImmediate(this._read.bind(this));
	}

	return input;
};

module.exports = Mixer;
