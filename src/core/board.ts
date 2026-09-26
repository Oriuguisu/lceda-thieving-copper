import type { Bounds, Point } from './geometry';
import {
	appendArcPoints,
	appendPoint,
	boundsOfPoints,
	complexPolygonToPaths,
	isUsableBounds,
	pointInPolygon,
	signedArea,
} from './geometry';
import { padHoleRing } from './holes';

const BOARD_OUTLINE_LAYER = 11;
const MULTI_LAYER = 12;
const STITCH_TOLERANCE_MIL = 5;
const MIN_RING_POINTS = 3;

export interface BoardOutline {
	bounds: Bounds;
	/** 板内挖空（BoardCutout）轮廓。 */
	holes: Array<Array<Point>>;
	outer: Array<Point>;
}

function distance(left: Point, right: Point): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

function isClosed(chain: ReadonlyArray<Point>): boolean {
	return chain.length >= MIN_RING_POINTS
		&& distance(chain[0], chain[chain.length - 1]) <= STITCH_TOLERANCE_MIL;
}

/**
 * 把散落的板框线段首尾相接成闭合环。
 *
 * @remarks 板框在 EDA 里是一组互不相干的线/弧图元，只有拼接后才知道哪里是板内。
 */
function stitchRings(chains: ReadonlyArray<Array<Point>>): Array<Array<Point>> {
	const pending = chains.filter(chain => chain.length >= 2).map(chain => [...chain]);
	const rings: Array<Array<Point>> = [];

	while (pending.length > 0) {
		const ring = pending.shift()!;
		let extended = true;

		while (extended && !isClosed(ring)) {
			extended = false;
			const tail = ring[ring.length - 1];

			for (let index = 0; index < pending.length; index += 1) {
				const candidate = pending[index];
				const head = candidate[0];
				const end = candidate[candidate.length - 1];

				if (distance(tail, head) <= STITCH_TOLERANCE_MIL) {
					pending.splice(index, 1);
					for (const point of candidate.slice(1)) {
						appendPoint(ring, point);
					}
					extended = true;
					break;
				}
				if (distance(tail, end) <= STITCH_TOLERANCE_MIL) {
					pending.splice(index, 1);
					for (const point of candidate.slice(0, -1).reverse()) {
						appendPoint(ring, point);
					}
					extended = true;
					break;
				}
			}
		}

		if (ring.length >= MIN_RING_POINTS) {
			rings.push(ring);
		}
	}

	return rings;
}

async function collectOutlineChains(): Promise<Array<Array<Point>>> {
	const layer = BOARD_OUTLINE_LAYER as TPCB_LayersOfLine;
	const chains: Array<Array<Point>> = [];

	const lines = await eda.pcb_PrimitiveLine.getAll(undefined, layer).catch(() => []);
	for (const line of lines) {
		chains.push([
			{ x: line.getState_StartX(), y: line.getState_StartY() },
			{ x: line.getState_EndX(), y: line.getState_EndY() },
		]);
	}

	const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, layer).catch(() => []);
	for (const arc of arcs) {
		const start = { x: arc.getState_StartX(), y: arc.getState_StartY() };
		const end = { x: arc.getState_EndX(), y: arc.getState_EndY() };
		const points = [start];
		appendArcPoints(points, start, end, arc.getState_ArcAngle());
		if (points.length >= 2) {
			chains.push(points);
		}
	}

	const polylines = await eda.pcb_PrimitivePolyline.getAll(undefined, layer).catch(() => []);
	for (const polyline of polylines) {
		for (const path of complexPolygonToPaths(polyline.getState_Polygon())) {
			chains.push(path);
		}
	}

	return chains;
}

/**
 * 收集板内挖槽轮廓。
 *
 * @remarks
 * 嘉立创 EDA 用「多层」上的填充表示板子的挖槽/开孔，它不属于任何铜层，
 * 但对盗铜而言等同于板边，必须按板边间距避让。
 */
async function collectCutoutRings(): Promise<Array<Array<Point>>> {
	const rings: Array<Array<Point>> = [];

	const fills = await eda.pcb_PrimitiveFill.getAll(MULTI_LAYER as TPCB_LayersOfFill).catch(() => []);
	for (const fill of fills) {
		rings.push(...complexPolygonToPaths(fill.getState_ComplexPolygon()));
	}

	const polylines = await eda.pcb_PrimitivePolyline
		.getAll(undefined, MULTI_LAYER as TPCB_LayersOfLine)
		.catch(() => []);
	for (const polyline of polylines) {
		rings.push(...complexPolygonToPaths(polyline.getState_Polygon()));
	}

	// 非金属化孔同样是机械开孔，按板边间距避让而不是铜间距。
	const pads = await eda.pcb_PrimitivePad.getAll().catch(() => []);
	for (const pad of pads) {
		if (pad.getState_Metallization()) {
			continue;
		}
		const ring = padHoleRing(pad);
		if (ring) {
			rings.push(ring);
		}
	}

	return rings.filter(ring => ring.length >= MIN_RING_POINTS);
}

export async function readBoardOutline(): Promise<BoardOutline> {
	const rings = stitchRings(await collectOutlineChains())
		.map(ring => ({ ring, area: Math.abs(signedArea(ring)) }))
		.filter(item => item.area > 1)
		.sort((left, right) => right.area - left.area);

	if (rings.length === 0) {
		throw new Error('没有在板框层找到闭合的板子轮廓，请先确认板框已经画好且首尾相接。');
	}

	const outer = rings[0].ring;
	const bounds = boundsOfPoints(outer);
	if (!isUsableBounds(bounds)) {
		throw new Error('板框轮廓的尺寸无效，无法计算盗铜区域。');
	}

	const holes = [
		...rings.slice(1).map(item => item.ring),
		...await collectCutoutRings(),
	].filter(ring => pointInPolygon(ring[0], outer));

	return { outer, holes, bounds };
}
