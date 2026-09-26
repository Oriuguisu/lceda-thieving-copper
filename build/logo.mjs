import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/**
 * 生成扩展图标。
 *
 * @remarks
 * 图形本身就是插件干的事：一条铜色走线，两侧铺满按安全间距自动避开它的盗铜块。
 * 程序化绘制而不是用位图素材，既能随时改尺寸，也不存在素材版权问题。
 */
const SIZE = 512;
const SUPERSAMPLE = 4;
const CANVAS = SIZE * SUPERSAMPLE;

const BACKGROUND = [0x0E, 0x32, 0x26];
const TRACK = [0xC9, 0x7E, 0x3C];
const BLOCK = [0xD9, 0x8F, 0x4E];

const TRACK_WIDTH = 38;
const BLOCK_SIZE = 64;
const BLOCK_RADIUS = 10;
const BLOCK_PITCH = 96;
const TRACK_CLEARANCE = 22;
/** 方块外缘到画布边的留白，太小会显得像被裁掉。 */
const EDGE_MARGIN = 26;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, '../images/logo.png');

const pixels = Buffer.alloc(CANVAS * CANVAS * 3);

function setPixel(x, y, colour) {
	const offset = (y * CANVAS + x) * 3;
	pixels[offset] = colour[0];
	pixels[offset + 1] = colour[1];
	pixels[offset + 2] = colour[2];
}

function fillBackground() {
	for (let y = 0; y < CANVAS; y += 1) {
		for (let x = 0; x < CANVAS; x += 1) {
			setPixel(x, y, BACKGROUND);
		}
	}
}

/** 圆角方块，坐标与尺寸都用 512 基准的逻辑单位。 */
function fillRoundedSquare(centreX, centreY, size, radius, colour) {
	const half = (size / 2) * SUPERSAMPLE;
	const r = radius * SUPERSAMPLE;
	const cx = centreX * SUPERSAMPLE;
	const cy = centreY * SUPERSAMPLE;
	const left = Math.max(0, Math.floor(cx - half));
	const right = Math.min(CANVAS - 1, Math.ceil(cx + half));
	const top = Math.max(0, Math.floor(cy - half));
	const bottom = Math.min(CANVAS - 1, Math.ceil(cy + half));

	for (let y = top; y <= bottom; y += 1) {
		for (let x = left; x <= right; x += 1) {
			const dx = Math.abs(x + 0.5 - cx);
			const dy = Math.abs(y + 0.5 - cy);
			if (dx > half || dy > half) {
				continue;
			}
			const cornerX = dx - (half - r);
			const cornerY = dy - (half - r);
			if (cornerX > 0 && cornerY > 0 && Math.hypot(cornerX, cornerY) > r) {
				continue;
			}
			setPixel(x, y, colour);
		}
	}
}

/** 45 度走线，直线方程为 x + y = SIZE。 */
function fillTrack() {
	const halfWidth = (TRACK_WIDTH / 2) * SUPERSAMPLE;
	const constant = SIZE * SUPERSAMPLE;
	for (let y = 0; y < CANVAS; y += 1) {
		for (let x = 0; x < CANVAS; x += 1) {
			if (Math.abs(x + 0.5 + y + 0.5 - constant) / Math.SQRT2 <= halfWidth) {
				setPixel(x, y, TRACK);
			}
		}
	}
}

/** 方块中心到走线的距离，要大于半线宽 + 间隙 + 方块在法线方向的半投影。 */
function isClearOfTrack(centreX, centreY) {
	const distance = Math.abs(centreX + centreY - SIZE) / Math.SQRT2;
	const blockReach = BLOCK_SIZE / Math.SQRT2;
	return distance > TRACK_WIDTH / 2 + TRACK_CLEARANCE + blockReach;
}

function fillBlocks() {
	const rowPitch = BLOCK_PITCH * Math.sqrt(3) / 2;
	const margin = BLOCK_SIZE / 2 + EDGE_MARGIN;
	let placed = 0;

	for (let row = 0; ; row += 1) {
		const centreY = margin + row * rowPitch;
		if (centreY > SIZE - margin) {
			break;
		}
		const offset = row % 2 === 1 ? BLOCK_PITCH / 2 : 0;
		for (let column = 0; ; column += 1) {
			const centreX = margin + offset + column * BLOCK_PITCH;
			if (centreX > SIZE - margin) {
				break;
			}
			if (isClearOfTrack(centreX, centreY)) {
				fillRoundedSquare(centreX, centreY, BLOCK_SIZE, BLOCK_RADIUS, BLOCK);
				placed += 1;
			}
		}
	}
	return placed;
}

/** 超采样降采样回目标尺寸，斜边和圆角才平滑。 */
function downsample() {
	const output = Buffer.alloc(SIZE * SIZE * 3);
	const samples = SUPERSAMPLE * SUPERSAMPLE;
	for (let y = 0; y < SIZE; y += 1) {
		for (let x = 0; x < SIZE; x += 1) {
			let red = 0;
			let green = 0;
			let blue = 0;
			for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
				for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
					const offset = (((y * SUPERSAMPLE) + sy) * CANVAS + (x * SUPERSAMPLE) + sx) * 3;
					red += pixels[offset];
					green += pixels[offset + 1];
					blue += pixels[offset + 2];
				}
			}
			const target = (y * SIZE + x) * 3;
			output[target] = Math.round(red / samples);
			output[target + 1] = Math.round(green / samples);
			output[target + 2] = Math.round(blue / samples);
		}
	}
	return output;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) {
		value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
	}
	return value >>> 0;
});

function crc32(buffer) {
	let crc = 0xFFFFFFFF;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(rgb) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(SIZE, 0);
	header.writeUInt32BE(SIZE, 4);
	header[8] = 8; // 位深
	header[9] = 2; // 真彩色
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;

	const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
	for (let y = 0; y < SIZE; y += 1) {
		const target = y * (SIZE * 3 + 1);
		raw[target] = 0; // 无过滤
		rgb.copy(raw, target + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
		chunk('IHDR', header),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

try {
	fillBackground();
	const placed = fillBlocks();
	fillTrack();
	const png = encodePng(downsample());
	fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
	fs.writeFileSync(OUTPUT, png);
	console.log(`Logo written: ${OUTPUT} (${SIZE}x${SIZE}, ${placed} blocks, ${png.length} bytes)`);
}
catch (error) {
	console.error('Logo generation failed:', error);
	process.exit(1);
}
