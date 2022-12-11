/**
 * Moving average calculator
 */
class Mave {
    constructor(length, iterations) {
        if (!Number.isInteger(length) || length <= 0) {
            throw new Error('Invalid length specified. Length should be an integer larger than 0');
        }

        if (!Number.isInteger(iterations) || iterations <= 0) {
            throw new Error('Invalid iterations specified. Iterations should be an integer larger than 0');
        }

        this._firstBuffer;
        this._lastBuffer;
        this.ave = 0;
        this._callbacks = [];

        for (let i = 0; i < iterations; i++) {
            let b = new aveBuffer(length);

            // Subscribe to init event
            this.onInit(val => {
                b.init(val);
            });

            if (!this._firstBuffer) {
                this._firstBuffer = b;
            } else {
                // subscribe to previous buffer onUpdate event
                this._lastBuffer.onUpdate(val => {
                    b.set(val);
                })
            }

            this._lastBuffer = b;
        }

        this._lastBuffer.onUpdate(val => {
            this.ave = val;
        });
    }

    /**
     * Set next value
     * @param {Number} val 
     */
    set(val) {
        this._firstBuffer.set(val);
    }

    /**
     * Initialize moving average calculator
     * @param {Number} val 
     */
    init(val) {
        this._callbacks.forEach(c => {
            c(val);
        });
        this.ave = val;
    }

    /**
     * Executes callback when init() is called.
     * @param {Function} callback 
     */
    onInit(callback) {
        if (typeof callback === 'function') {
            this._callbacks.push(callback);
        }
    }
}

class aveBuffer {
    constructor(length) {
        this._arr = new Array(Math.round(length));
        this._index = 0;
        this._length = length;
        this._callbacks = [];
    }

    set(val) {
        this._arr[this._index] = val;
        this._index++;
        if (this._index >= this._length) {
            this._index = 0;

            // Calculate average when array is filled
            let ave = this._arr.reduce((a, b) => a + b) / this._length;
            this._callbacks.forEach(c => {
                c(ave);
            });
        }
    }

    init(val) {
        this._arr.fill(val);
    }

    onUpdate(callback) {
        if (typeof callback === 'function') {
            this._callbacks.push(callback);
        }
    }
}

module.exports = Mave;