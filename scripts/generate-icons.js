import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
    if (!crc32.table) {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        crc32.table = table;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createSolidPng(size, [r, g, b]) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(2, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    const rowLength = size * 3 + 1;
    const raw = Buffer.alloc(rowLength * size);
    for (let y = 0; y < size; y++) {
        const rowStart = y * rowLength;
        raw[rowStart] = 0;
        for (let x = 0; x < size; x++) {
            const px = rowStart + 1 + x * 3;
            raw[px] = r;
            raw[px + 1] = g;
            raw[px + 2] = b;
        }
    }
    const idat = zlib.deflateSync(raw);

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), createSolidPng(192, [108, 92, 231]));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createSolidPng(512, [108, 92, 231]));
console.log('Generated icons/icon-192.png and icons/icon-512.png');
