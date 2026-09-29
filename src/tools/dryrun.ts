import type { Point } from '../core/geometry';
import type { Obstacle } from '../core/obstacles';
import { hasMethod } from '../core/api';
import { readBoardOutline } from '../core/board';
import { pointInPolygon } from '../core/geometry';
import { buildCoverageMask, resolvePixelsPerMil } from '../core/mask';
import { collectCopperObstacles } from '../core/obstacles';
import { normalizeSettings } from '../core/settings';
import { generateThieving, listCopperLayers, planBlockCentres } from '../core/thieving';
import { millimetresToMil, milToMillimetres } from '../core/units';

const VERIFY_SAMPLE_LIMIT = 400;

/** 这些接口在不同 EDA 版本上有增删，缺失时插件会退化而不是报错。 */
const OPTIONAL_APIS: Array<[string, unknown, string]> = [
	['pcb_Document.stopCanvasUpdateCalculation', () => eda.pcb_Document, 'stopCanvasUpdateCalculation'],
	['pcb_Document.startCanvasUpdateCalculation', () => eda.pcb_Document, 'startCanvasUpdateCalculation'],
	['pcb_Document.triggerCanvasUpdateCalculation', () => eda.pcb_Document, 'triggerCanvasUpdateCalculation'],
	['pcb_Primitive.getPrimitiveBoardLine', () => eda.pcb_Primitive, 'getPrimitiveBoardLine'],
	['pcb_Primitive.getPrimitivesBBox', () => eda.pcb_Primitive, 'getPrimitivesBBox'],
	['pcb_Net.getAllNetsName', () => eda.pcb_Net, 'getAllNetsName'],
	['pcb_Layer.getAllLayers', () => eda.pcb_Layer, 'getAllLayers'],
	['sys_IFrame.isIFrameAlreadyExist', () => eda.sys_IFrame, 'isIFrameAlreadyExist'],
	['sys_IFrame.openIFrame', () => eda.sys_IFrame, 'openIFrame'],
];

function checkApiAvailability(): Record<string, boolean> {
	const report: Record<string, boolean> = {};
	for (const [label, resolve, method] of OPTIONAL_APIS) {
		try {
			report[label] = hasMethod((resolve as () => unknown)(), method);
		}
		catch {
			report[label] = false;
		}
	}
	return report;
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
	const deltaX = end.x - start.x;
	const deltaY = end.y - start.y;
	const lengthSquared = deltaX * deltaX + deltaY * deltaY;
	if (lengthSquared < 1e-12) {
		return Math.hypot(point.x - start.x, point.y - start.y);
	}
	const t = Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared));
	return Math.hypot(point.x - (start.x + t * deltaX), point.y - (start.y + t * deltaY));
}

function pointToPathDistance(point: Point, path: ReadonlyArray<Point>, closed: boolean): number {
	let best = Number.POSITIVE_INFINITY;
	const last = closed ? path.length : path.length - 1;
	for (let index = 0; index < last; index += 1) {
		best = Math.min(best, pointToSegmentDistance(point, path[index], path[(index + 1) % path.length]));
	}
	return best;
}

/** 候选中心到某个障碍表面的距离，落在障碍内部记为 0。 */
function distanceToObstacle(point: Point, obstacle: Obstacle): number {
	if (obstacle.kind === 'circle') {
		return Math.max(0, Math.hypot(point.x - obstacle.center.x, point.y - obstacle.center.y) - obstacle.radius);
	}
	if (obstacle.kind === 'stroke') {
		return Math.max(0, pointToPathDistance(point, obstacle.points, false) - obstacle.width / 2);
	}
	let best = Number.POSITIVE_INFINITY;
	for (const ring of obstacle.rings) {
		if (pointInPolygon(point, ring)) {
			return 0;
		}
		best = Math.min(best, pointToPathDistance(point, ring, true));
	}
	return best;
}

/**
 * 真实生成一次，用于制作演示素材或人工验收。
 *
 * @remarks 会在当前文档创建图元，只应在演示板上运行。
 */
export async function generateForDemo(overrides: Record<string, unknown> = {}): Promise<unknown> {
	const layers = await listCopperLayers();
	const settings = normalizeSettings({
		layers: layers.length > 0 ? [layers[0].id] : [1],
		...overrides,
	});

	const messages: Array<string> = [];
	const outcome = await generateThieving(settings, (percent, message) => {
		messages.push(`${Math.round(percent)}% ${message}`);
	});

	return { settings, outcome, messages };
}

/**
 * 只读自检：在真实 PCB 上跑通板框识别、障碍收集与空位计算，不创建任何图元，
 * 并用解析式距离计算独立复核栅格遮罩给出的候选位置。
 *
 * @remarks 通过 eda_run_js 手动执行，不参与扩展打包。
 */
export async function dryRun(overrides: Record<string, unknown> = {}): Promise<unknown> {
	const layers = await listCopperLayers();
	const settings = normalizeSettings({
		layers: layers.length > 0 ? [layers[0].id] : [1],
		...overrides,
	});

	const board = await readBoardOutline();
	const collected = await collectCopperObstacles({
		layer: settings.layers[0],
		avoidKeepouts: settings.avoidKeepouts,
		avoidComponents: settings.avoidComponents,
	});

	const mask = buildCoverageMask({
		board,
		range: { kind: 'board' },
		pixelsPerMil: resolvePixelsPerMil(board.bounds, settings.precisionMm),
		obstacles: collected.obstacles,
		boardClearanceMil: millimetresToMil(settings.boardClearanceMm),
		copperClearanceMil: millimetresToMil(settings.clearanceMm),
	});
	const centres = planBlockCentres(board.bounds, mask.isRectangleFree, settings);

	// 用块的外接圆半径做最坏情况估计，结果应当不小于设定的安全间距。
	const worstRadius = millimetresToMil(settings.blockSizeMm) / 2 * Math.SQRT2;
	let worstCopperGapMm = Number.POSITIVE_INFINITY;
	let worstBoardGapMm = Number.POSITIVE_INFINITY;

	for (const centre of centres.slice(0, VERIFY_SAMPLE_LIMIT)) {
		for (const obstacle of collected.obstacles) {
			const gap = distanceToObstacle(centre, obstacle) - worstRadius;
			worstCopperGapMm = Math.min(worstCopperGapMm, milToMillimetres(gap));
		}
		const boardGap = pointToPathDistance(centre, board.outer, true) - worstRadius;
		worstBoardGapMm = Math.min(worstBoardGapMm, milToMillimetres(boardGap));
	}

	const messages: Array<string> = [];
	const outcome = await generateThieving(settings, (percent, message) => {
		messages.push(`${Math.round(percent)}% ${message}`);
	}, { dryRun: true });

	return {
		apiAvailability: checkApiAvailability(),
		copperLayers: layers,
		settings,
		board: {
			outerPoints: board.outer.length,
			holes: board.holes.length,
			boundsMm: {
				minX: milToMillimetres(board.bounds.minX),
				minY: milToMillimetres(board.bounds.minY),
				maxX: milToMillimetres(board.bounds.maxX),
				maxY: milToMillimetres(board.bounds.maxY),
			},
		},
		obstacles: {
			total: collected.obstacles.length,
			byKind: collected.obstacles.reduce<Record<string, number>>((counts, obstacle) => {
				counts[obstacle.kind] = (counts[obstacle.kind] ?? 0) + 1;
				return counts;
			}, {}),
			warnings: collected.warnings,
		},
		mask: { width: mask.width, height: mask.height, pixelMm: milToMillimetres(1 / mask.pixelsPerMil) },
		verification: {
			checked: Math.min(centres.length, VERIFY_SAMPLE_LIMIT),
			requiredCopperGapMm: settings.clearanceMm,
			worstCopperGapMm,
			requiredBoardGapMm: settings.boardClearanceMm,
			worstBoardGapMm,
			firstCentresMm: centres.slice(0, 5).map(centre => ({
				x: milToMillimetres(centre.x),
				y: milToMillimetres(centre.y),
			})),
		},
		outcome,
		messages,
	};
}
