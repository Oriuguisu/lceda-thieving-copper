import { invokeOptional } from './api';

const SETTINGS_KEY = 'thieving-settings';
const RECORD_KEY_PREFIX = 'thieving-blocks:';

export type ThievingPattern = 'grid' | 'staggered';
export type ThievingShape = 'circle' | 'diamond' | 'square';
export type RangeMode = 'board' | 'edge' | 'rectangle';

export interface RectangleMm {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

export interface ThievingSettings {
	/** 按器件整体轮廓避让，可覆盖封装内部不单独成图元的铜。 */
	avoidComponents: boolean;
	/** 避开铺铜禁止区、填充禁止区等禁布规则区域。 */
	avoidKeepouts: boolean;
	blockSizeMm: number;
	boardClearanceMm: number;
	clearanceMm: number;
	edgeMarginMm: number;
	layers: Array<number>;
	lockPrimitives: boolean;
	maxBlocks: number;
	net: string;
	pattern: ThievingPattern;
	pitchMm: number;
	/** 空白判定的栅格精度，越小越准也越慢。 */
	precisionMm: number;
	rangeMode: RangeMode;
	rectangleMm?: RectangleMm;
	shape: ThievingShape;
}

export interface ThievingRecord {
	createdAt: number;
	layers: Array<number>;
	primitiveIds: Array<string>;
}

export const DEFAULT_SETTINGS: ThievingSettings = {
	avoidComponents: true,
	avoidKeepouts: true,
	blockSizeMm: 1,
	boardClearanceMm: 1,
	clearanceMm: 0.5,
	edgeMarginMm: 5,
	layers: [1],
	lockPrimitives: false,
	maxBlocks: 5000,
	net: '',
	pattern: 'staggered',
	pitchMm: 2,
	precisionMm: 0.05,
	rangeMode: 'board',
	shape: 'square',
};

function positiveNumber(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeSettings(input: Partial<ThievingSettings> | undefined): ThievingSettings {
	const source = input ?? {};
	const layers = Array.isArray(source.layers)
		? source.layers.map(Number).filter(layer => Number.isInteger(layer) && layer > 0)
		: [];

	return {
		avoidComponents: source.avoidComponents ?? DEFAULT_SETTINGS.avoidComponents,
		avoidKeepouts: source.avoidKeepouts ?? DEFAULT_SETTINGS.avoidKeepouts,
		blockSizeMm: positiveNumber(source.blockSizeMm, DEFAULT_SETTINGS.blockSizeMm),
		boardClearanceMm: nonNegativeNumber(source.boardClearanceMm, DEFAULT_SETTINGS.boardClearanceMm),
		clearanceMm: nonNegativeNumber(source.clearanceMm, DEFAULT_SETTINGS.clearanceMm),
		edgeMarginMm: positiveNumber(source.edgeMarginMm, DEFAULT_SETTINGS.edgeMarginMm),
		layers: layers.length > 0 ? layers : [...DEFAULT_SETTINGS.layers],
		lockPrimitives: source.lockPrimitives ?? DEFAULT_SETTINGS.lockPrimitives,
		maxBlocks: Math.min(200000, Math.round(positiveNumber(source.maxBlocks, DEFAULT_SETTINGS.maxBlocks))),
		net: typeof source.net === 'string' ? source.net.trim() : DEFAULT_SETTINGS.net,
		pattern: source.pattern === 'grid' ? 'grid' : 'staggered',
		pitchMm: positiveNumber(source.pitchMm, DEFAULT_SETTINGS.pitchMm),
		precisionMm: Math.min(0.5, Math.max(0.01, positiveNumber(source.precisionMm, DEFAULT_SETTINGS.precisionMm))),
		rangeMode: source.rangeMode === 'edge' || source.rangeMode === 'rectangle'
			? source.rangeMode
			: 'board',
		rectangleMm: source.rectangleMm,
		shape: source.shape === 'circle' || source.shape === 'diamond' ? source.shape : 'square',
	};
}

export function validateSettings(settings: ThievingSettings): void {
	if (settings.pitchMm <= settings.blockSizeMm) {
		throw new Error('中心间距必须大于铜块尺寸，否则相邻盗铜会连成一片。');
	}
	if (settings.pitchMm - settings.blockSizeMm < settings.clearanceMm) {
		throw new Error('中心间距减去铜块尺寸必须不小于安全间距，否则盗铜之间会违反间距规则。');
	}
	if (settings.layers.length === 0) {
		throw new Error('请至少选择一个目标铜层。');
	}
	if (settings.rangeMode === 'rectangle' && !settings.rectangleMm) {
		throw new Error('矩形范围模式需要先指定范围坐标。');
	}
}

export function loadSettings(): ThievingSettings {
	try {
		return normalizeSettings(eda.sys_Storage.getExtensionUserConfig(SETTINGS_KEY));
	}
	catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: ThievingSettings): Promise<void> {
	await invokeOptional(eda.sys_Storage, 'setExtensionUserConfig', SETTINGS_KEY, settings);
}

function recordKey(documentUuid: string): string {
	return `${RECORD_KEY_PREFIX}${documentUuid}`;
}

export function loadRecords(documentUuid: string): Array<ThievingRecord> {
	try {
		const stored = eda.sys_Storage.getExtensionUserConfig(recordKey(documentUuid));
		return Array.isArray(stored) ? (stored as Array<ThievingRecord>) : [];
	}
	catch {
		return [];
	}
}

export async function appendRecord(documentUuid: string, record: ThievingRecord): Promise<void> {
	const records = [...loadRecords(documentUuid), record].slice(-20);
	await invokeOptional(eda.sys_Storage, 'setExtensionUserConfig', recordKey(documentUuid), records);
}

export async function clearRecords(documentUuid: string): Promise<void> {
	await invokeOptional(eda.sys_Storage, 'deleteExtensionUserConfig', recordKey(documentUuid));
}
