import type { Point } from './geometry';
import { invokeOptional } from './api';
import {
	appendArcPoints,
	complexPolygonToPaths,
	ellipsePoints,
	oblongPoints,
	rectanglePoints,
	rotatePoint,
} from './geometry';
import { padHoleRing } from './holes';

const LAYER_MULTI = 12;
const LAYER_TOP = 1;
const LAYER_BOTTOM = 2;
/** 只有这些禁布规则会阻止铜箔落地，仅禁止摆放器件的区域不影响盗铜。 */
const COPPER_BLOCKING_RULES = new Set([5, 6, 7, 8]);

export type Obstacle
	= | { kind: 'circle'; center: Point; radius: number }
		| { kind: 'polygon'; rings: Array<Array<Point>> }
		| { kind: 'stroke'; points: Array<Point>; width: number };

export interface ObstacleOptions {
	avoidComponents: boolean;
	avoidKeepouts: boolean;
	layer: number;
}

export interface ObstacleResult {
	obstacles: Array<Obstacle>;
	warnings: Array<string>;
}

function padShapeToPoints(
	shape: TPCB_PrimitivePadShape,
	center: Point,
): Array<Point> | undefined {
	const type = shape[0] as string;
	if (type === 'ELLIPSE') {
		return ellipsePoints(center, Number(shape[1]) / 2, Number(shape[2]) / 2);
	}
	if (type === 'OVAL') {
		return oblongPoints(center, Number(shape[1]), Number(shape[2]));
	}
	if (type === 'RECT') {
		return rectanglePoints(center, Number(shape[1]), Number(shape[2]));
	}
	if (type === 'NGON') {
		// 正多边形内接于同尺寸椭圆，用椭圆代替会略微放大，对避让来说是安全的方向。
		return ellipsePoints(center, Number(shape[1]) / 2, Number(shape[2]) / 2);
	}
	return undefined;
}

/**
 * 用 EDA 自己算好的边框线兜底，适用于形状复杂或坐标基准不明的图元。
 */
async function boardLineObstacle(
	primitiveId: string,
	layer: number,
): Promise<Obstacle | undefined> {
	const outline = await invokeOptional<IPCB_ComplexPolygon>(
		eda.pcb_Primitive,
		'getPrimitiveBoardLine',
		primitiveId,
		[layer as EPCB_LayerId],
	);
	const rings = complexPolygonToPaths(outline);
	return rings.length > 0 ? { kind: 'polygon', rings } : undefined;
}

async function collectLines(layer: number, obstacles: Array<Obstacle>): Promise<void> {
	const lines = await eda.pcb_PrimitiveLine.getAll(undefined, layer as TPCB_LayersOfLine).catch(() => []);
	for (const line of lines) {
		obstacles.push({
			kind: 'stroke',
			width: line.getState_LineWidth(),
			points: [
				{ x: line.getState_StartX(), y: line.getState_StartY() },
				{ x: line.getState_EndX(), y: line.getState_EndY() },
			],
		});
	}

	const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, layer as TPCB_LayersOfLine).catch(() => []);
	for (const arc of arcs) {
		const start = { x: arc.getState_StartX(), y: arc.getState_StartY() };
		const end = { x: arc.getState_EndX(), y: arc.getState_EndY() };
		const points = [start];
		appendArcPoints(points, start, end, arc.getState_ArcAngle());
		obstacles.push({ kind: 'stroke', width: arc.getState_LineWidth(), points });
	}

	const polylines = await eda.pcb_PrimitivePolyline.getAll(undefined, layer as TPCB_LayersOfLine).catch(() => []);
	for (const polyline of polylines) {
		for (const path of complexPolygonToPaths(polyline.getState_Polygon())) {
			obstacles.push({ kind: 'stroke', width: polyline.getState_LineWidth(), points: path });
		}
	}
}

async function collectVias(obstacles: Array<Obstacle>): Promise<void> {
	const vias = await eda.pcb_PrimitiveVia.getAll().catch(() => []);
	for (const via of vias) {
		obstacles.push({
			kind: 'circle',
			center: { x: via.getState_X(), y: via.getState_Y() },
			radius: Math.max(via.getState_Diameter(), via.getState_HoleDiameter()) / 2,
		});
	}
}

/**
 * 器件焊盘不一定会出现在 `pcb_PrimitivePad.getAll` 的结果里，再按器件补一次以防漏掉。
 */
async function collectComponentPadIds(): Promise<Array<string>> {
	const components = await eda.pcb_PrimitiveComponent.getAll().catch(() => []);
	return components.flatMap(component => (component.getState_Pads() ?? []).map(pad => pad.primitiveId));
}

async function collectPads(
	layer: number,
	obstacles: Array<Obstacle>,
	warnings: Array<string>,
): Promise<void> {
	const padLayers = layer === LAYER_TOP || layer === LAYER_BOTTOM
		? [layer, LAYER_MULTI]
		: [LAYER_MULTI];
	const pads: Array<IPCB_PrimitivePad> = [];
	const seen = new Set<string>();

	const addPad = (pad: IPCB_PrimitivePad): void => {
		const id = pad.getState_PrimitiveId();
		if (!seen.has(id) && padLayers.includes(Number(pad.getState_Layer()))) {
			seen.add(id);
			pads.push(pad);
		}
	};

	for (const padLayer of padLayers) {
		const found = await eda.pcb_PrimitivePad.getAll(padLayer as TPCB_LayersOfPad).catch(() => []);
		for (const pad of found) {
			addPad(pad);
		}
	}

	const componentPadIds = (await collectComponentPadIds()).filter(id => !seen.has(id));
	if (componentPadIds.length > 0) {
		const componentPads = await eda.pcb_PrimitivePad.get(componentPadIds).catch(() => []);
		for (const pad of componentPads) {
			addPad(pad);
		}
	}

	let unresolved = 0;
	for (const pad of pads) {
		const center = { x: pad.getState_X(), y: pad.getState_Y() };
		const shape = pad.getState_Pad();
		const points = shape ? padShapeToPoints(shape, center) : undefined;

		const holeRing = padHoleRing(pad);
		if (holeRing) {
			obstacles.push({ kind: 'polygon', rings: [holeRing] });
		}

		if (points) {
			const rotation = pad.getState_Rotation();
			obstacles.push({
				kind: 'polygon',
				rings: [points.map(point => rotatePoint(point, center, rotation))],
			});
			continue;
		}

		const fallback = await boardLineObstacle(pad.getState_PrimitiveId(), layer);
		if (fallback) {
			obstacles.push(fallback);
		}
		else if (!holeRing) {
			unresolved += 1;
		}
	}

	if (unresolved > 0) {
		warnings.push(`有 ${unresolved} 个异形焊盘无法解析轮廓，已跳过，请生成后运行 DRC 复核。`);
	}
}

async function collectFillsAndRegions(
	options: ObstacleOptions,
	obstacles: Array<Obstacle>,
): Promise<void> {
	const fills = await eda.pcb_PrimitiveFill.getAll(options.layer as TPCB_LayersOfFill).catch(() => []);
	for (const fill of fills) {
		const rings = complexPolygonToPaths(fill.getState_ComplexPolygon());
		if (rings.length > 0) {
			obstacles.push({ kind: 'polygon', rings });
		}
	}

	if (!options.avoidKeepouts) {
		return;
	}

	for (const regionLayer of [options.layer, LAYER_MULTI]) {
		const regions = await eda.pcb_PrimitiveRegion.getAll(regionLayer as TPCB_LayersOfRegion).catch(() => []);
		for (const region of regions) {
			const blocking = region.getState_RuleType().some(rule => COPPER_BLOCKING_RULES.has(rule));
			if (!blocking) {
				continue;
			}
			const rings = complexPolygonToPaths(region.getState_ComplexPolygon());
			if (rings.length > 0) {
				obstacles.push({ kind: 'polygon', rings });
			}
		}
	}
}

async function collectPours(layer: number, obstacles: Array<Obstacle>): Promise<void> {
	const pours = await eda.pcb_PrimitivePour.getAll(undefined, layer as TPCB_LayersOfCopper).catch(() => []);
	if (pours.length === 0) {
		return;
	}

	const allPoured = await eda.pcb_PrimitivePoured.getAll().catch(() => []);
	const pouredByPour = new Map<string, Array<IPCB_PrimitivePoured>>();
	for (const poured of allPoured) {
		const key = poured.getState_PourPrimitiveId();
		const list = pouredByPour.get(key) ?? [];
		list.push(poured);
		pouredByPour.set(key, list);
	}

	for (const pour of pours) {
		const poured = pouredByPour.get(pour.getState_PrimitiveId()) ?? [];
		if (poured.length === 0) {
			// 尚未铺铜时只能按铺铜区外框整体避让。
			const rings = complexPolygonToPaths(pour.getState_ComplexPolygon());
			if (rings.length > 0) {
				obstacles.push({ kind: 'polygon', rings });
			}
			continue;
		}

		for (const item of poured) {
			for (const pourFill of item.getState_PourFills()) {
				const rings = complexPolygonToPaths(pourFill.path);
				if (rings.length === 0) {
					continue;
				}
				obstacles.push({ kind: 'polygon', rings });
				if (pourFill.lineWidth > 0) {
					for (const ring of rings) {
						obstacles.push({ kind: 'stroke', points: ring, width: pourFill.lineWidth });
					}
				}
			}
		}
	}
}

/**
 * 按器件整体轮廓避让，顺带覆盖封装内部那些不会单独出现在图元列表里的铜。
 */
async function collectComponents(layer: number, obstacles: Array<Obstacle>): Promise<void> {
	const components = await eda.pcb_PrimitiveComponent.getAll().catch(() => []);
	const batchSize = 16;

	for (let index = 0; index < components.length; index += batchSize) {
		const batch = components.slice(index, index + batchSize);
		const results = await Promise.all(
			batch.map(component => boardLineObstacle(component.getState_PrimitiveId(), layer)),
		);
		for (const obstacle of results) {
			if (obstacle) {
				obstacles.push(obstacle);
			}
		}
	}
}

async function collectTextsAndImages(layer: number, obstacles: Array<Obstacle>): Promise<void> {
	const strings = await eda.pcb_PrimitiveString.getAll(layer as TPCB_LayersOfImage).catch(() => []);
	const images = await eda.pcb_PrimitiveImage.getAll(layer as TPCB_LayersOfImage).catch(() => []);

	for (const primitive of [...strings, ...images]) {
		const obstacle = await boardLineObstacle(primitive.getState_PrimitiveId(), layer);
		if (obstacle) {
			obstacles.push(obstacle);
		}
	}
}

/**
 * 收集目标铜层上所有会与盗铜冲突的既有铜箔。
 */
export async function collectCopperObstacles(options: ObstacleOptions): Promise<ObstacleResult> {
	const obstacles: Array<Obstacle> = [];
	const warnings: Array<string> = [];

	await collectLines(options.layer, obstacles);
	await collectVias(obstacles);
	await collectPads(options.layer, obstacles, warnings);
	await collectFillsAndRegions(options, obstacles);
	await collectPours(options.layer, obstacles);
	await collectTextsAndImages(options.layer, obstacles);
	if (options.avoidComponents) {
		await collectComponents(options.layer, obstacles);
	}

	return { obstacles, warnings };
}
