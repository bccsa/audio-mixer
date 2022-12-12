/**
 * Proportional & Integral controller
 * @property {Number} sp - Set-point
 * @property {Number} pv - Process Variable (input)
 * @property {Number} p - Proportional control factor
 * @property {Number} i - Integral control factor (time base = 1 second)
 * @property {Number} cv - Control variable (output)
 * @property {Number} mincv - If set, clamps cv to not be less than mincv
 * @property {Number} maxcv - If set, clamps cv to not exceed maxcv
 * @property {Boolean} invert - true = invert response (err = pv - sp); false = normal response (err = sp - pv);
 */
class piController {
    constructor() {
        this._deltaT = new deltaT();
        this.sp = 0;
        this.pv = 1;
        this.p = 1;
        this.i = 0;
        this.invert = false;
        this._cv = 0;
        this._sumI = 0;
        this.mincv = undefined;
        this.maxcv = undefined;
        this._antiWindup = false;
    }

    /**
     * Control variable (output)
     */
    get cv() {
        let err;
        let dt = this._deltaT.delta;

        if (this.invert) {
            err = this.pv - this.sp;
        } else {
            err = this.sp - this.pv;
        }
        // Proportional control
        let p = err * this.p;

        if (dt && !this._antiWindup) {
            // Integral control
            this._sumI += err * this.i * dt;
        }
        
        let cv = p + this._sumI;

        if (this.mincv != undefined && cv < this.mincv) {
            cv = this.mincv;
            this._antiWindup = true;
        } else if (this.maxcv != undefined && cv > this.maxcv) {
            cv = this.maxcv;
            this._antiWindup = true;
        } else {
            this._antiWindup = false;
        }
        return cv;
    }
}

/**
 * Signal dampener
 * @property {Number} dFactor - Dampening factor in seconds
 * @property {Number} in - Raw Input
 * @property {Output} out - Dampened Output
 */
class dampener {
    /**
     * Signal dampener
     * @param {Number} dFactor - Dampening factor in seconds
     */
    constructor(dFactor = 1) {
        this.dFactor = dFactor;
        this._output;
        this._deltaT = new deltaT();
        this._input;
    }

    /**
     * Input
     * @param {Number} val
     */
    set in(val) {
        this._input = val;
        if (typeof val === 'number') {
            let dt = this._deltaT.delta;
            if (dt) {
                this._output += (val - this._output) / this.dFactor * dt;
            } else {
                this._output = val;
            }
        }
    }

    get in() {
        return this._input;
    }

    /**
     * Dampened output
     */
    get out() {
        return this._output;
    }
}

/**
 * Delta time measurement
 */
class deltaT {
    constructor() {
        this._hrtime;
    }

    /**
     * Get the delta time since the last call. On first call, undefined is returned.
     */
    get delta() {
        if (this._hrtime) {
            let t = process.hrtime();
            let o = t[0] - this._hrtime[0] + (t[1] - this._hrtime[1]) / 1000000000;
            this._hrtime = t;
            return o;
        } else {
            this._hrtime = process.hrtime();
            return undefined;
        }
    }
}

/**
 * Rate measurement
 */
class rate {
    /**
     * Average sample rate measurement
     * @param {Number} dampTime - Signal dampening time in seconds
     * @param {Number} Rate - Initial sample rate
     */
    constructor(dampTime, rate) {
        this._deltaT = new deltaT();
        this._rate = rate;
        this._damp = new dampener(dampTime);
    }

    /**
     * Number of samples
     * @param {Number} val
     */
    set samples(val) {
        let dt = this._deltaT.delta;
        if (dt) {
            this._damp.in = val / dt;
        } else {
            this._damp.in = this._rate;
        }
    }

    /**
     * Measured sample rate
     */
    get rate() {
        return this._damp._output;
    }
}

module.exports.piController = piController;
module.exports.dampener = dampener;
module.exports.deltaT = deltaT;
module.exports.rate = rate;