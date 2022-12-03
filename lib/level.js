const events = require('events');

/**
 * Level indication calculations
 */
class Level extends events {
    constructor(bitDepth, sampleRate) {
        super();
        this._sampleRoof = Math.pow(2, bitDepth - 1) - 1;
        this._sampleFloor = -this._sampleRoof - 1;

        this._peak1000th = new peakBuffer(sampleRate, 1 / 1000);
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
            this._level = peak / this._sampleRoof; // Convert from int16/24/32 level to factor of 1.
            this.emit('level', this._level);
            this._peak3.setLevel(this._level);
            // Update 3-sec peak every 1/10 seconds to give moving peak
            this._peak = this._peak3.getPeak();
            this.emit('peak', this._peak);
        });
    }

    /**
     * Get the current audio level
     */
    get level() {
        return this._level;
    }

    /**
     * Get the 3s audio peak
     */
    get peak() {
        return this._peak;
    }

    /**
     * Calculate the short and long term (3s) peaks.
     */
    calc(sample) {
        this._peak1000th.setLevel(Math.abs(sample));
    }
}

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

module.exports = Level;