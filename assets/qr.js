// QR code encoder (ISO/IEC 18004), written here because this app takes no
// outside libraries and its CSP allows no CDN. Used for the authenticator
// setup code on the second-factor enrolment page: any element with a
// data-qr attribute gets that text drawn into it as an SVG. Byte mode, error
// correction level M, versions 1-40. Structure follows the reference
// algorithm step by step: encode data, add Reed-Solomon error correction,
// interleave blocks, draw function patterns, place data, pick the mask with
// the lowest penalty. Nothing is sent anywhere — this runs in the browser.
(function () {
    'use strict';

    // Error correction level M, indexed by version (0 unused).
    const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
    const NUM_ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
    const ECL_FORMAT_BITS = 0; // M

    function numRawDataModules(ver) {
        let result = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            const numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7) result -= 36;
        }
        return result;
    }

    function numDataCodewords(ver) {
        return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ver] * NUM_ECC_BLOCKS[ver];
    }

    // ---- Reed-Solomon over GF(2^8), polynomial 0x11D ----
    function gfMultiply(x, y) {
        let z = 0;
        for (let i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11D);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }

    function rsDivisor(degree) {
        const result = new Array(degree).fill(0);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < result.length; j++) {
                result[j] = gfMultiply(result[j], root);
                if (j + 1 < result.length) result[j] ^= result[j + 1];
            }
            root = gfMultiply(root, 0x02);
        }
        return result;
    }

    function rsRemainder(data, divisor) {
        const result = new Array(divisor.length).fill(0);
        for (const b of data) {
            const factor = b ^ result.shift();
            result.push(0);
            divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
        }
        return result;
    }

    // ---- Data encoding ----
    function encodeData(bytes) {
        let ver = 1;
        for (; ver <= 40; ver++) {
            const countBits = ver <= 9 ? 8 : 16;
            if (4 + countBits + bytes.length * 8 <= numDataCodewords(ver) * 8) break;
        }
        if (ver > 40) throw new Error('Too much data for a QR code');

        const bits = [];
        const append = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
        append(0b0100, 4); // byte mode
        append(bytes.length, ver <= 9 ? 8 : 16);
        for (const b of bytes) append(b, 8);

        const capacity = numDataCodewords(ver) * 8;
        append(0, Math.min(4, capacity - bits.length));
        append(0, (8 - bits.length % 8) % 8);
        for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);

        const codewords = [];
        for (let i = 0; i < bits.length; i += 8) {
            codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
        }
        return { ver, codewords };
    }

    function addEccAndInterleave(ver, data) {
        const numBlocks = NUM_ECC_BLOCKS[ver];
        const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver];
        const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
        const numShortBlocks = numBlocks - rawCodewords % numBlocks;
        const shortBlockLen = Math.floor(rawCodewords / numBlocks);

        const divisor = rsDivisor(blockEccLen);
        const blocks = [];
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
            k += dat.length;
            const ecc = rsRemainder(dat, divisor);
            if (i < numShortBlocks) dat.push(0);
            blocks.push(dat.concat(ecc));
        }

        const result = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
                // The padding byte added to short blocks above isn't real data.
                if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
            });
        }
        return result;
    }

    // ---- Matrix ----
    function buildMatrix(ver, codewords) {
        const size = ver * 4 + 17;
        const modules = Array.from({ length: size }, () => new Array(size).fill(false));
        const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
        const setFunction = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

        for (let i = 0; i < size; i++) {
            setFunction(6, i, i % 2 === 0);
            setFunction(i, 6, i % 2 === 0);
        }

        const drawFinder = (cx, cy) => {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const x = cx + dx, y = cy + dy;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
                }
            }
        };
        drawFinder(3, 3);
        drawFinder(size - 4, 3);
        drawFinder(3, size - 4);

        const alignPositions = (() => {
            if (ver === 1) return [];
            const numAlign = Math.floor(ver / 7) + 2;
            const step = ver === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
            const result = [6];
            for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
            return result;
        })();
        const n = alignPositions.length;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        setFunction(alignPositions[i] + dx, alignPositions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                    }
                }
            }
        }

        const drawFormatBits = (mask) => {
            const data = (ECL_FORMAT_BITS << 3) | mask;
            let rem = data;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = ((data << 10) | rem) ^ 0x5412;
            const bit = (i) => ((bits >>> i) & 1) !== 0;
            for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
            setFunction(8, 7, bit(6));
            setFunction(8, 8, bit(7));
            setFunction(7, 8, bit(8));
            for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
            for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
            for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
            setFunction(8, size - 8, true); // the always-dark module
        };
        drawFormatBits(0); // reserves the area; redrawn with the chosen mask below

        if (ver >= 7) {
            let rem = ver;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const bits = (ver << 12) | rem;
            for (let i = 0; i < 18; i++) {
                const dark = ((bits >>> i) & 1) !== 0;
                const a = size - 11 + i % 3, b = Math.floor(i / 3);
                setFunction(a, b, dark);
                setFunction(b, a, dark);
            }
        }

        // Data, in the standard two-column zigzag from the bottom right.
        let bitIndex = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
                        modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
                        bitIndex++;
                    }
                }
            }
        }

        const MASKS = [
            (x, y) => (x + y) % 2 === 0,
            (x, y) => y % 2 === 0,
            (x) => x % 3 === 0,
            (x, y) => (x + y) % 3 === 0,
            (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
            (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
            (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
            (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
        ];
        const applyMask = (m) => {
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    if (!isFunction[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
                }
            }
        };

        let bestMask = 0;
        let bestScore = Infinity;
        for (let m = 0; m < 8; m++) {
            applyMask(m);
            drawFormatBits(m);
            const score = penalty(modules, size);
            if (score < bestScore) { bestScore = score; bestMask = m; }
            applyMask(m); // XOR again undoes it
        }
        applyMask(bestMask);
        drawFormatBits(bestMask);
        return modules;
    }

    // The standard four penalty rules, used only to choose the most
    // scanner-friendly of the eight masks — any mask decodes correctly.
    function penalty(modules, size) {
        let score = 0;
        const lines = [];
        for (let i = 0; i < size; i++) {
            lines.push(modules[i]);
            lines.push(modules.map((row) => row[i]));
        }
        for (const line of lines) {
            let run = 1;
            for (let i = 1; i <= size; i++) {
                if (i < size && line[i] === line[i - 1]) {
                    run++;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
            const str = line.map((d) => (d ? '1' : '0')).join('');
            for (const pattern of ['10111010000', '00001011101']) {
                for (let at = str.indexOf(pattern); at !== -1; at = str.indexOf(pattern, at + 1)) score += 40;
            }
        }
        let dark = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (modules[y][x]) dark++;
                if (y + 1 < size && x + 1 < size) {
                    const c = modules[y][x];
                    if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) score += 3;
                }
            }
        }
        score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
        return score;
    }

    /** text -> square boolean matrix (true = dark), no quiet zone. */
    function encodeQr(text) {
        const bytes = Array.from(new TextEncoder().encode(text));
        const { ver, codewords } = encodeData(bytes);
        return buildMatrix(ver, addEccAndInterleave(ver, codewords));
    }

    /** SVG markup for the matrix, with the 4-module quiet zone scanners need. */
    function toSvg(modules) {
        const size = modules.length;
        const quiet = 4;
        let path = '';
        modules.forEach((row, y) => row.forEach((dark, x) => {
            if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        }));
        const dim = size + quiet * 2;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
            + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { encodeQr, toSvg };
        return;
    }

    /** Draw into one element that already has a data-qr attribute. */
    function drawInto(el) {
        // The SVG is built only from this file's own fixed markup and
        // numbers — the encoded text itself never reaches innerHTML.
        el.innerHTML = toSvg(encodeQr(el.dataset.qr));
    }

    /* Added for this app: the Call book builds its dialogs long after
       DOMContentLoaded, so the sweep below can never reach them. Everything
       else in this file is as it is in Database Administration. */
    window.qrDraw = function (root) {
        (root || document).querySelectorAll('[data-qr]').forEach(drawInto);
    };

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-qr]').forEach(drawInto);
    });
})();
