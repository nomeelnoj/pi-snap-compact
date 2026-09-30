/**
 * Minimal PNG encoder built on node:zlib — no native dependencies.
 *
 * Supports the two output modes the frame rasterizer needs:
 *  - 8-bit palette-indexed (color type 3) for crisp 1-bit pixel-font frames
 *  - 8-bit RGB (color type 2) for anti-aliased (stretched / TrueType) frames
 *
 * All scanlines use filter type 0 (none). Pixel fonts compress extremely well
 * under deflate even without filtering, and skipping filters keeps the encoder
 * simple and fast.
 *
 * TypeScript port of the Rust renderer in @oh-my-pi/pi-natives
 * (crates/pi-natives/src/snapcompact.rs, MIT, Copyright (c) 2025-2026 Can Bölük,
 * (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { deflateSync } from "node:zlib";

/** CRC-32 (IEEE 802.3) lookup table, built once. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([typeBuf, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Buffer {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = bitDepth;
	data[9] = colorType;
	data[10] = 0; // compression: deflate
	data[11] = 0; // filter: adaptive
	data[12] = 0; // interlace: none
	return chunk("IHDR", data);
}

/** Wrap raw scanline data (already including per-row filter bytes) into a PNG. */
function assemble(width: number, height: number, colorType: number, raw: Buffer, palette?: [number, number, number][]): Buffer {
	const parts: Buffer[] = [PNG_SIGNATURE, ihdr(width, height, 8, colorType)];
	if (palette) {
		const plte = Buffer.alloc(palette.length * 3);
		palette.forEach(([r, g, b], i) => {
			plte[i * 3] = r;
			plte[i * 3 + 1] = g;
			plte[i * 3 + 2] = b;
		});
		parts.push(chunk("PLTE", plte));
	}
	parts.push(chunk("IDAT", deflateSync(raw, { level: 9 })));
	parts.push(chunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
}

/**
 * Encode an indexed-color PNG. `pixels` holds one palette index per pixel,
 * row-major, exactly `width * height` entries. Palette index 0 should be the
 * background so runs of it deflate well.
 */
export function encodePngIndexed(width: number, height: number, palette: [number, number, number][], pixels: Uint8Array): Buffer {
	if (pixels.length !== width * height) {
		throw new Error(`indexed PNG: expected ${width * height} pixels, got ${pixels.length}`);
	}
	const raw = Buffer.alloc(height * (width + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (width + 1)] = 0; // filter: none
		Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1);
	}
	return assemble(width, height, 3, raw, palette);
}

/**
 * Encode a truecolor RGB PNG. `rgb` holds three bytes per pixel, row-major,
 * exactly `width * height * 3` entries.
 */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Buffer {
	if (rgb.length !== width * height * 3) {
		throw new Error(`RGB PNG: expected ${width * height * 3} bytes, got ${rgb.length}`);
	}
	const stride = width * 3;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	return assemble(width, height, 2, raw);
}
