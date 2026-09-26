import type { Point } from './geometry';
import type { ThievingRange } from './mask';
import type { ThievingSettings } from './settings';
import { invokeOptional } from './api';
import { readBoardOutline } from './board';
import { boundsOfPoints, complexPolygonToPaths, ellipsePoints, rectanglePoints } from './geometry';
import { buildCoverageMask, resolvePixelsPerMil } from './mask';
import { collectCopperObstacles } from './obstacles';
import { yieldToUi } from './panel';
import { appendRecord, clearRecords, loadRecords, validateSettings } from './settings';
import { millimetresToMil } from './units';

const PCB_DOCUMENT_TYPE = 3;
const FILL_MODE_SOLID = 0;
const CIRCLE_SEGMENTS = 16;
const CREATE_BATCH_SIZE = 16;
const DELETE_BATCH_SIZE = 200;
/** 盗铜最多是 16 边的圆，顶点更多的填充不当作盗铜。 */
const MAX_BLOCK_VERTICES = 40;

export type ProgressReporter = (percent: number, message: string) => void;

export interface CopperLayerInfo {
	id: number;
	name: string;
}

export interface LayerOutcome {
	created: number;
	layer: number;
	layerName: string;
}

export interface ThievingOutcome {
	dryRun: boolean;
	limited: boolean;
	outcomes: Array<LayerOutcome>;
	primitiveIds: Array<string>;
	warnings: Array<string>;
}

export interface GenerateOptions {
	/** 只统计可铺设的位置，不创建任何图元。 */
	dryRun?: boolean;
}

export async function requirePcbDocumentUuid(): Promise<string> {
	const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!info || info.documentType !== PCB_DOCUMENT_TYPE) {
		throw new Error('请先打开一个 PCB 文档，再运行盗铜工具。');
	}
	return String((info as unknown as { uuid?: string }).uuid ?? 'current');
}

/** 暂停/恢复画布更新计算只在 EDA v4.2 及以上存在，缺失时静默跳过。 */
async function setCanvasUpdate(enabled: boolean): Promise<void> {
	if (enabled) {
		await invokeOptional(eda.pcb_Document, 'startCanvasUpdateCalculation');
		await invokeOptional(eda.pcb_Document, 'triggerCanvasUpdateCalculation');
		return;
	}
	await invokeOptional(eda.pcb_Document, 'stopCanvasUpdateCalculation');
}

export async function listCopperLayers(): Promise<Array<CopperLayerInfo>> {
	const layers = await invokeOptional<Array<IPCB_LayerItem>>(eda.pcb_Layer, 'getAllLayers') ?? [];
	return layers
		.filter((layer) => {
			const type = String(layer.type);
			return (type === 'SIGNAL' || type === 'PLANE') && Number(layer.layerStatus) !== 0;
		})
		.map(layer => ({ id: Number(layer.id), name: layer.name }));
}

async function resolveRange(settings: ThievingSettings): Promise<ThievingRange> {
	if (settings.rangeMode === 'edge') {
		return { kind: 'edge', marginMil: millimetresToMil(settings.edgeMarginMm) };
	}
	if (settings.rangeMode === 'rectangle' && settings.rectangleMm) {
		const rectangle = settings.rectangleMm;
		const first = await eda.pcb_Document.convertCanvasOriginToDataOrigin(
			millimetresToMil(rectangle.minX),
			millimetresToMil(rectangle.minY),
		);
		const second = await eda.pcb_Document.convertCanvasOriginToDataOrigin(
			millimetresToMil(rectangle.maxX),
			millimetresToMil(rectangle.maxY),
		);
		return {
			kind: 'rectangle',
			rect: {
				minX: Math.min(first.x, second.x),
				maxX: Math.max(first.x, second.x),
				minY: Math.min(first.y, second.y),
				maxY: Math.max(first.y, second.y),
			},
		};
	}
	return { kind: 'board' };
}

function blockPoints(centre: Point, settings: ThievingSettings): Array<Point> {
	const half = millimetresToMil(settings.blockSizeMm) / 2;
	if (settings.shape === 'circle') {
		return ellipsePoints(centre, half, half, CIRCLE_SEGMENTS);
	}
	if (settings.shape === 'diamond') {
		return [
			{ x: centre.x, y: centre.y + half },
			{ x: centre.x + half, y: centre.y },
			{ x: centre.x, y: centre.y - half },
			{ x: centre.x - half, y: centre.y },
		];
	}
	return rectanglePoints(centre, half * 2, half * 2);
}

function pointsToPolygonSource(points: ReadonlyArray<Point>): TPCB_PolygonSourceArray {
	const source: TPCB_PolygonSourceArray = [points[0].x, points[0].y];
	for (const point of points.slice(1)) {
		source.push('L', point.x, point.y);
	}
	source.push('L', points[0].x, points[0].y);
	return source;
}

/**
 * 按网格扫描所有候选位置，只保留整块都落在空白区的中心点。
 *
 * @remarks 同时供只读自检脚本复算候选点使用。
 */
export function planBlockCentres(
	bounds: { maxX: number; maxY: number; minX: number; minY: number },
	isFree: (rect: { maxX: number; maxY: number; minX: number; minY: number }) => boolean,
	settings: ThievingSettings,
): Array<Point> {
	const pitch = millimetresToMil(settings.pitchMm);
	const half = millimetresToMil(settings.blockSizeMm) / 2;
	const rowPitch = settings.pattern === 'staggered' ? pitch * Math.sqrt(3) / 2 : pitch;
	const centres: Array<Point> = [];

	// 网格相位固定对齐数据原点，重复运行同一块板得到的位置保持一致。
	const firstRow = Math.floor(bounds.minY / rowPitch);
	const lastRow = Math.ceil(bounds.maxY / rowPitch);

	for (let row = firstRow; row <= lastRow; row += 1) {
		const y = row * rowPitch;
		if (y < bounds.minY || y > bounds.maxY) {
			continue;
		}
		const offset = settings.pattern === 'staggered' && Math.abs(row % 2) === 1 ? pitch / 2 : 0;
		const firstColumn = Math.floor((bounds.minX - offset) / pitch);
		const lastColumn = Math.ceil((bounds.maxX - offset) / pitch);

		for (let column = firstColumn; column <= lastColumn; column += 1) {
			const x = column * pitch + offset;
			if (x < bounds.minX || x > bounds.maxX) {
				continue;
			}
			if (isFree({ minX: x - half, maxX: x + half, minY: y - half, maxY: y + half })) {
				centres.push({ x, y });
			}
		}
	}

	return centres;
}

async function createBlocks(
	layer: number,
	centres: ReadonlyArray<Point>,
	settings: ThievingSettings,
	onBatch: (done: number) => void,
): Promise<Array<string>> {
	const created: Array<string> = [];

	for (let index = 0; index < centres.length; index += CREATE_BATCH_SIZE) {
		const batch = centres.slice(index, index + CREATE_BATCH_SIZE);
		const fills = await Promise.all(batch.map(async (centre) => {
			const polygon = eda.pcb_MathPolygon.createPolygon(
				pointsToPolygonSource(blockPoints(centre, settings)),
			);
			if (!polygon) {
				return undefined;
			}
			return eda.pcb_PrimitiveFill
				.create(
					layer as TPCB_LayersOfFill,
					polygon,
					settings.net || undefined,
					FILL_MODE_SOLID as EPCB_PrimitiveFillMode,
					0,
					settings.lockPrimitives,
				)
				.catch(() => undefined);
		}));

		for (const fill of fills) {
			if (fill) {
				created.push(fill.getState_PrimitiveId());
			}
		}
		onBatch(created.length);
	}

	return created;
}

export async function generateThieving(
	settings: ThievingSettings,
	report: ProgressReporter,
	options: GenerateOptions = {},
): Promise<ThievingOutcome> {
	validateSettings(settings);
	const dryRun = options.dryRun ?? false;

	if (settings.net) {
		const names = await invokeOptional<Array<string>>(eda.pcb_Net, 'getAllNetsName') ?? [];
		if (names.length > 0 && !names.includes(settings.net)) {
			throw new Error(`PCB 中不存在网络「${settings.net}」，请留空或填写已有网络。`);
		}
	}

	const documentUuid = await requirePcbDocumentUuid();
	report(2, '正在读取板框轮廓…');
	const board = await readBoardOutline();
	const range = await resolveRange(settings);
	const layerNames = new Map((await listCopperLayers()).map(layer => [layer.id, layer.name]));
	const pixelsPerMil = resolvePixelsPerMil(board.bounds, settings.precisionMm);

	const outcomes: Array<LayerOutcome> = [];
	const primitiveIds: Array<string> = [];
	const warnings: Array<string> = [];
	const share = 94 / settings.layers.length;
	let remaining = settings.maxBlocks;
	let limited = false;

	if (!dryRun) {
		await setCanvasUpdate(false);
	}
	try {
		for (const [index, layer] of settings.layers.entries()) {
			const layerName = layerNames.get(layer) ?? `层 ${layer}`;
			const base = 4 + index * share;

			report(base, `正在收集「${layerName}」上的既有铜箔…`);
			await yieldToUi();
			const collected = await collectCopperObstacles({
				layer,
				avoidKeepouts: settings.avoidKeepouts,
				avoidComponents: settings.avoidComponents,
			});
			warnings.push(...collected.warnings);

			report(base + share * 0.3, `正在分析「${layerName}」的空白区域…`);
			await yieldToUi();
			const mask = buildCoverageMask({
				board,
				range,
				pixelsPerMil,
				obstacles: collected.obstacles,
				boardClearanceMil: millimetresToMil(settings.boardClearanceMm),
				copperClearanceMil: millimetresToMil(settings.clearanceMm),
			});

			const centres = planBlockCentres(board.bounds, mask.isRectangleFree, settings);
			if (centres.length > remaining) {
				limited = true;
				centres.length = Math.max(0, remaining);
			}

			if (dryRun) {
				report(base + share, `「${layerName}」可铺设 ${centres.length} 个盗铜。`);
				remaining -= centres.length;
				outcomes.push({ layer, layerName, created: centres.length });
				if (remaining <= 0) {
					break;
				}
				continue;
			}

			report(base + share * 0.5, `正在「${layerName}」上创建 ${centres.length} 个盗铜…`);
			await yieldToUi();
			const ids = await createBlocks(layer, centres, settings, (done) => {
				const ratio = centres.length > 0 ? done / centres.length : 1;
				report(base + share * (0.5 + 0.5 * ratio), `「${layerName}」已创建 ${done}/${centres.length}`);
			});

			primitiveIds.push(...ids);
			remaining -= ids.length;
			outcomes.push({ layer, layerName, created: ids.length });

			if (remaining <= 0) {
				limited = limited || settings.layers.length > index + 1;
				break;
			}
		}
	}
	finally {
		if (!dryRun) {
			await setCanvasUpdate(true);
		}
	}

	if (primitiveIds.length > 0) {
		await appendRecord(documentUuid, {
			primitiveIds,
			layers: [...settings.layers],
			createdAt: Date.now(),
		});
	}

	report(100, dryRun ? '预览完成。' : '盗铜生成完成。');
	return { outcomes, primitiveIds, warnings, limited, dryRun };
}

/**
 * 按外框尺寸找出目标层上疑似盗铜的填充，用于清理没有生成记录的盗铜。
 *
 * @remarks 只认单环、顶点数不多且外框接近正方形的填充，尽量不误伤手工画的铜。
 */
export async function findBlocksBySize(settings: ThievingSettings): Promise<Array<string>> {
	const target = millimetresToMil(settings.blockSizeMm);
	const tolerance = target * 0.06 + 1;
	const matched: Array<string> = [];

	for (const layer of settings.layers) {
		const fills = await eda.pcb_PrimitiveFill.getAll(layer as TPCB_LayersOfFill).catch(() => []);
		for (const fill of fills) {
			const rings = complexPolygonToPaths(fill.getState_ComplexPolygon());
			if (rings.length !== 1 || rings[0].length > MAX_BLOCK_VERTICES) {
				continue;
			}
			const bounds = boundsOfPoints(rings[0]);
			const width = bounds.maxX - bounds.minX;
			const height = bounds.maxY - bounds.minY;
			if (Math.abs(width - target) <= tolerance && Math.abs(height - target) <= tolerance) {
				matched.push(fill.getState_PrimitiveId());
			}
		}
	}

	return matched;
}

async function deleteFills(ids: ReadonlyArray<string>): Promise<void> {
	await setCanvasUpdate(false);
	try {
		for (let index = 0; index < ids.length; index += DELETE_BATCH_SIZE) {
			await eda.pcb_PrimitiveFill
				.delete(ids.slice(index, index + DELETE_BATCH_SIZE))
				.catch(() => false);
		}
	}
	finally {
		await setCanvasUpdate(true);
	}
}

export async function removeBlocksBySize(
	settings: ThievingSettings,
	documentUuid: string,
): Promise<number> {
	const ids = await findBlocksBySize(settings);
	if (ids.length === 0) {
		return 0;
	}
	await deleteFills(ids);
	await clearRecords(documentUuid);
	return ids.length;
}

export async function removeThievingBlocks(documentUuid: string): Promise<number> {
	const ids = loadRecords(documentUuid).flatMap(record => record.primitiveIds);
	if (ids.length === 0) {
		return 0;
	}

	await deleteFills(ids);
	await clearRecords(documentUuid);
	return ids.length;
}

export function countRecordedBlocks(documentUuid: string): number {
	return loadRecords(documentUuid).reduce((total, record) => total + record.primitiveIds.length, 0);
}
