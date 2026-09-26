import type { BoardOutline } from './board';
import type { Bounds, Point } from './geometry';
import type { Obstacle } from './obstacles';
import { MILLIMETRES_PER_MIL } from './units';

/** 抗锯齿边缘按“不可用”处理，宁可少铺一颗也不要压线。 */
const FREE_PIXEL_THRESHOLD = 250;
const MAX_MASK_SIDE = 4096;
const MIN_MASK_SIDE = 16;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type ThievingRange
	= | { kind: 'board' }
		| { kind: 'edge'; marginMil: number }
		| { kind: 'rectangle'; rect: Bounds };

export interface MaskOptions {
	board: BoardOutline;
	boardClearanceMil: number;
	copperClearanceMil: number;
	obstacles: ReadonlyArray<Obstacle>;
	pixelsPerMil: number;
	range: ThievingRange;
}

export interface CoverageMask {
	bounds: Bounds;
	height: number;
	isRectangleFree: (rect: Bounds) => boolean;
	pixelsPerMil: number;
	width: number;
}

function createContext(width: number, height: number): Context2D {
	if (typeof OffscreenCanvas !== 'undefined') {
		const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
		if (context) {
			return context;
		}
	}
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (context) {
			return context;
		}
	}
	throw new Error('当前 EDA 运行环境不支持 Canvas，无法分析板上空白区域。');
}

/**
 * 在给定精度上限内挑选遮罩分辨率，板子越大自动降精度以免爆内存。
 */
export function resolvePixelsPerMil(bounds: Bounds, millimetresPerPixel: number): number {
	const requested = MILLIMETRES_PER_MIL / Math.max(0.005, millimetresPerPixel);
	const widthMil = bounds.maxX - bounds.minX;
	const heightMil = bounds.maxY - bounds.minY;
	const longestMil = Math.max(widthMil, heightMil, 1);
	return Math.min(requested, MAX_MASK_SIDE / longestMil);
}

export function maskPixelSizeMillimetres(pixelsPerMil: number): number {
	return MILLIMETRES_PER_MIL / pixelsPerMil;
}

function tracePolygon(
	context: Context2D,
	points: ReadonlyArray<Point>,
	toX: (value: number) => number,
	toY: (value: number) => number,
): void {
	if (points.length === 0) {
		return;
	}
	context.moveTo(toX(points[0].x), toY(points[0].y));
	for (const point of points.slice(1)) {
		context.lineTo(toX(point.x), toY(point.y));
	}
	context.closePath();
}

function tracePolyline(
	context: Context2D,
	points: ReadonlyArray<Point>,
	toX: (value: number) => number,
	toY: (value: number) => number,
): void {
	if (points.length === 0) {
		return;
	}
	context.moveTo(toX(points[0].x), toY(points[0].y));
	for (const point of points.slice(1)) {
		context.lineTo(toX(point.x), toY(point.y));
	}
}

function drawObstacles(
	context: Context2D,
	obstacles: ReadonlyArray<Obstacle>,
	clearancePixels: number,
	scale: number,
	toX: (value: number) => number,
	toY: (value: number) => number,
): void {
	context.fillStyle = '#000000';
	context.strokeStyle = '#000000';
	context.lineJoin = 'round';
	context.lineCap = 'round';

	for (const obstacle of obstacles) {
		if (obstacle.kind === 'circle') {
			context.beginPath();
			context.arc(
				toX(obstacle.center.x),
				toY(obstacle.center.y),
				Math.max(0.5, obstacle.radius * scale + clearancePixels),
				0,
				Math.PI * 2,
			);
			context.fill();
			continue;
		}

		if (obstacle.kind === 'stroke') {
			if (obstacle.points.length < 2) {
				continue;
			}
			context.beginPath();
			tracePolyline(context, obstacle.points, toX, toY);
			context.lineWidth = Math.max(1, obstacle.width * scale + clearancePixels * 2);
			context.stroke();
			continue;
		}

		context.beginPath();
		for (const ring of obstacle.rings) {
			tracePolygon(context, ring, toX, toY);
		}
		context.fill();
		if (clearancePixels > 0) {
			context.lineWidth = clearancePixels * 2;
			context.stroke();
		}
	}
}

function applyRange(
	context: Context2D,
	options: MaskOptions,
	toX: (value: number) => number,
	toY: (value: number) => number,
	width: number,
	height: number,
): void {
	if (options.range.kind === 'rectangle') {
		const rect = options.range.rect;
		const left = Math.max(0, Math.min(width, toX(rect.minX)));
		const right = Math.max(0, Math.min(width, toX(rect.maxX)));
		const top = Math.max(0, Math.min(height, toY(rect.maxY)));
		const bottom = Math.max(0, Math.min(height, toY(rect.minY)));
		context.fillStyle = '#000000';
		context.fillRect(0, 0, width, top);
		context.fillRect(0, bottom, width, height - bottom);
		context.fillRect(0, top, left, bottom - top);
		context.fillRect(right, top, width - right, bottom - top);
	}
}

/**
 * 板边环形模式：只保留距离板边一定宽度以内的带状区域。
 */
function buildEdgeBandMask(
	options: MaskOptions,
	scale: number,
	toX: (value: number) => number,
	toY: (value: number) => number,
	width: number,
	height: number,
): Uint8ClampedArray {
	const context = createContext(width, height);
	context.fillStyle = '#000000';
	context.fillRect(0, 0, width, height);
	context.strokeStyle = '#ffffff';
	context.lineJoin = 'round';
	context.lineCap = 'round';
	context.lineWidth = Math.max(1, (options.range.kind === 'edge' ? options.range.marginMil : 0) * scale * 2);

	context.beginPath();
	tracePolygon(context, options.board.outer, toX, toY);
	for (const hole of options.board.holes) {
		tracePolygon(context, hole, toX, toY);
	}
	context.stroke();

	return context.getImageData(0, 0, width, height).data;
}

export function buildCoverageMask(options: MaskOptions): CoverageMask {
	const bounds = options.board.bounds;
	const scale = options.pixelsPerMil;
	const width = Math.max(MIN_MASK_SIDE, Math.ceil((bounds.maxX - bounds.minX) * scale) + 2);
	const height = Math.max(MIN_MASK_SIDE, Math.ceil((bounds.maxY - bounds.minY) * scale) + 2);
	const toX = (value: number): number => (value - bounds.minX) * scale + 1;
	const toY = (value: number): number => (bounds.maxY - value) * scale + 1;
	const context = createContext(width, height);

	context.fillStyle = '#000000';
	context.fillRect(0, 0, width, height);

	context.beginPath();
	tracePolygon(context, options.board.outer, toX, toY);
	context.fillStyle = '#ffffff';
	context.fill();

	// 挖孔单独涂黑，避免多个开孔互相重叠时被 even-odd 规则又填回来。
	if (options.board.holes.length > 0) {
		context.beginPath();
		for (const hole of options.board.holes) {
			tracePolygon(context, hole, toX, toY);
		}
		context.fillStyle = '#000000';
		context.fill();
	}

	if (options.boardClearanceMil > 0) {
		context.strokeStyle = '#000000';
		context.lineJoin = 'round';
		context.lineCap = 'round';
		context.lineWidth = options.boardClearanceMil * scale * 2;
		context.beginPath();
		tracePolygon(context, options.board.outer, toX, toY);
		for (const hole of options.board.holes) {
			tracePolygon(context, hole, toX, toY);
		}
		context.stroke();
	}

	drawObstacles(context, options.obstacles, options.copperClearanceMil * scale, scale, toX, toY);
	applyRange(context, options, toX, toY, width, height);

	const pixels = context.getImageData(0, 0, width, height).data;
	const edgeBand = options.range.kind === 'edge'
		? buildEdgeBandMask(options, scale, toX, toY, width, height)
		: undefined;
	const allowed = new Uint8Array(width * height);
	for (let index = 0; index < allowed.length; index += 1) {
		const free = pixels[index * 4] >= FREE_PIXEL_THRESHOLD
			&& (!edgeBand || edgeBand[index * 4] >= FREE_PIXEL_THRESHOLD);
		allowed[index] = free ? 1 : 0;
	}

	const isRectangleFree = (rect: Bounds): boolean => {
		const left = Math.floor(toX(rect.minX));
		const right = Math.ceil(toX(rect.maxX));
		const top = Math.floor(toY(rect.maxY));
		const bottom = Math.ceil(toY(rect.minY));
		if (left < 0 || top < 0 || right >= width || bottom >= height) {
			return false;
		}
		for (let y = top; y <= bottom; y += 1) {
			const rowOffset = y * width;
			for (let x = left; x <= right; x += 1) {
				if (allowed[rowOffset + x] === 0) {
					return false;
				}
			}
		}
		return true;
	};

	return { bounds, width, height, pixelsPerMil: scale, isRectangleFree };
}
