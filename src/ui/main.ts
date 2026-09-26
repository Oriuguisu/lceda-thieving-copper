import type { RangeMode, ThievingSettings, ThievingShape } from '../core/settings';
import type { ThievingOutcome } from '../core/thieving';
import { invokeOptional } from '../core/api';
import { PANEL_IFRAME_ID } from '../core/panel';
import { loadSettings, normalizeSettings, saveSettings } from '../core/settings';
import {
	countRecordedBlocks,
	findBlocksBySize,
	generateThieving,
	listCopperLayers,
	removeBlocksBySize,
	removeThievingBlocks,
	requirePcbDocumentUuid,
} from '../core/thieving';
import { milToMillimetres } from '../core/units';

const CONFIRM_WINDOW_MS = 6000;
/** 读不到图层名时至少让顶层和底层可选，面板不至于没法用。 */
const FALLBACK_LAYERS = [
	{ id: 1, name: '顶层 Top Layer' },
	{ id: 2, name: '底层 Bottom Layer' },
];

const confirmDeadlines = new Map<string, number>();

/** 删除类操作需要在提示后的短时间内再点一次，避免误触。 */
function requiresConfirm(key: string, message: string): boolean {
	if ((confirmDeadlines.get(key) ?? 0) > Date.now()) {
		confirmDeadlines.delete(key);
		return false;
	}
	confirmDeadlines.set(key, Date.now() + CONFIRM_WINDOW_MS);
	setStatus(message);
	return true;
}

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) {
		throw new Error(`界面缺少控件：${id}`);
	}
	return found as T;
}

function input(id: string): HTMLInputElement {
	return element<HTMLInputElement>(id);
}

function select(id: string): HTMLSelectElement {
	return element<HTMLSelectElement>(id);
}

function numberValue(field: HTMLInputElement, fallback: number): number {
	const parsed = Number(field.value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, isError = false): void {
	const status = element('status');
	status.textContent = message;
	status.classList.toggle('error', isError);
}

function setProgress(percent: number): void {
	element('progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setBusy(busy: boolean): void {
	const ids = [
		'button-generate',
		'button-preview',
		'button-remove',
		'button-remove-all',
		'button-read-selection',
	];
	for (const id of ids) {
		const button = document.getElementById(id) as HTMLButtonElement | null;
		if (button) {
			button.disabled = busy;
		}
	}
}

function selectedLayers(): Array<number> {
	return [...element('field-layers').querySelectorAll<HTMLInputElement>('input:checked')]
		.map(checkbox => Number(checkbox.value));
}

function readForm(): ThievingSettings {
	const rangeMode = select('field-range-mode').value as RangeMode;
	return normalizeSettings({
		layers: selectedLayers(),
		shape: select('field-shape').value as ThievingShape,
		blockSizeMm: numberValue(input('field-block-size'), 1),
		pitchMm: numberValue(input('field-pitch'), 2),
		pattern: select('field-pattern').value === 'grid' ? 'grid' : 'staggered',
		net: input('field-net').value,
		clearanceMm: numberValue(input('field-clearance'), 0.5),
		boardClearanceMm: numberValue(input('field-board-clearance'), 1),
		avoidKeepouts: input('field-avoid-keepouts').checked,
		avoidComponents: input('field-avoid-components').checked,
		rangeMode,
		edgeMarginMm: numberValue(input('field-edge-margin'), 5),
		rectangleMm: rangeMode === 'rectangle'
			? {
					minX: numberValue(input('field-rect-min-x'), 0),
					minY: numberValue(input('field-rect-min-y'), 0),
					maxX: numberValue(input('field-rect-max-x'), 0),
					maxY: numberValue(input('field-rect-max-y'), 0),
				}
			: undefined,
		maxBlocks: numberValue(input('field-max-blocks'), 5000),
		precisionMm: Number(select('field-precision').value),
		lockPrimitives: input('field-lock').checked,
	});
}

function writeForm(settings: ThievingSettings): void {
	select('field-shape').value = settings.shape;
	input('field-block-size').value = String(settings.blockSizeMm);
	input('field-pitch').value = String(settings.pitchMm);
	select('field-pattern').value = settings.pattern;
	input('field-net').value = settings.net;
	input('field-clearance').value = String(settings.clearanceMm);
	input('field-board-clearance').value = String(settings.boardClearanceMm);
	input('field-avoid-keepouts').checked = settings.avoidKeepouts;
	input('field-avoid-components').checked = settings.avoidComponents;
	select('field-range-mode').value = settings.rangeMode;
	input('field-edge-margin').value = String(settings.edgeMarginMm);
	input('field-max-blocks').value = String(settings.maxBlocks);
	input('field-lock').checked = settings.lockPrimitives;

	const precision = select('field-precision');
	const precisionValue = String(settings.precisionMm);
	precision.value = [...precision.options].some(option => option.value === precisionValue)
		? precisionValue
		: '0.05';

	if (settings.rectangleMm) {
		input('field-rect-min-x').value = String(settings.rectangleMm.minX);
		input('field-rect-min-y').value = String(settings.rectangleMm.minY);
		input('field-rect-max-x').value = String(settings.rectangleMm.maxX);
		input('field-rect-max-y').value = String(settings.rectangleMm.maxY);
	}

	updateRangeVisibility();
}

function updateRangeVisibility(): void {
	const mode = select('field-range-mode').value;
	element('group-edge').classList.toggle('hidden', mode !== 'edge');
	element('group-rectangle').classList.toggle('hidden', mode !== 'rectangle');
}

async function renderLayers(selected: ReadonlyArray<number>): Promise<void> {
	const container = element('field-layers');
	const found = await listCopperLayers().catch(() => []);
	const layers = found.length > 0 ? found : FALLBACK_LAYERS;
	if (found.length === 0) {
		setStatus('没有读到图层信息，已列出默认的顶层和底层，请确认当前是 PCB 文档。', true);
	}

	container.textContent = '';
	for (const layer of layers) {
		const label = document.createElement('label');
		label.className = 'checkbox';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.value = String(layer.id);
		checkbox.checked = selected.includes(layer.id);
		label.append(checkbox, document.createTextNode(layer.name));
		container.append(label);
	}
}

function describeOutcome(outcome: ThievingOutcome): string {
	const total = outcome.outcomes.reduce((sum, item) => sum + item.created, 0);
	if (total === 0) {
		return '没有找到满足条件的空位。可以试试减小铜块尺寸、缩小间距，或降低安全间距。';
	}

	const lines = outcome.outcomes.map(item => `${item.layerName}：${item.created} 个`);
	lines.push(outcome.dryRun
		? `预计可铺设 ${total} 个盗铜，尚未创建任何图元。`
		: `共创建 ${total} 个盗铜，可用「删除本插件盗铜」一键撤销。`);
	if (outcome.limited) {
		lines.push('已达到数量上限，剩余位置未铺设。');
	}
	lines.push(...outcome.warnings);
	if (!outcome.dryRun) {
		lines.push('建议生成后运行一次 DRC 复核间距。');
	}
	return lines.join('\n');
}

async function handleGenerate(dryRun: boolean): Promise<void> {
	setBusy(true);
	setProgress(0);
	try {
		const settings = readForm();
		await saveSettings(settings);
		const outcome = await generateThieving(settings, (percent, message) => {
			setProgress(percent);
			setStatus(message);
		}, { dryRun });
		setStatus(describeOutcome(outcome));
	}
	catch (error) {
		setProgress(0);
		setStatus(errorMessage(error), true);
	}
	finally {
		setBusy(false);
	}
}

async function handleRemove(): Promise<void> {
	try {
		const documentUuid = await requirePcbDocumentUuid();
		const count = countRecordedBlocks(documentUuid);
		if (count === 0) {
			setStatus('当前文档没有本插件的生成记录，可以试试「按尺寸删除全部盗铜」。');
			return;
		}

		if (requiresConfirm('record', `即将删除记录中的 ${count} 个盗铜，请在 6 秒内再次点击确认。`)) {
			return;
		}

		setBusy(true);
		setStatus('正在删除…');
		const removed = await removeThievingBlocks(documentUuid);
		setStatus(`已删除 ${removed} 个盗铜。`);
	}
	catch (error) {
		setStatus(errorMessage(error), true);
	}
	finally {
		setBusy(false);
	}
}

async function handleRemoveAll(): Promise<void> {
	setBusy(true);
	try {
		const documentUuid = await requirePcbDocumentUuid();
		const settings = readForm();
		const matched = await findBlocksBySize(settings);
		if (matched.length === 0) {
			setStatus(`在所选铜层上没有找到外框约 ${settings.blockSizeMm} mm 的单个填充。`);
			return;
		}

		const layerCount = settings.layers.length;
		const confirmMessage = `在 ${layerCount} 个铜层上找到 ${matched.length} 个外框约 ${settings.blockSizeMm} mm 的填充，`
			+ '请在 6 秒内再次点击确认删除。';
		if (requiresConfirm('size', confirmMessage)) {
			return;
		}

		setStatus('正在删除…');
		const removed = await removeBlocksBySize(settings, documentUuid);
		setStatus(`已删除 ${removed} 个填充。`);
	}
	catch (error) {
		setStatus(errorMessage(error), true);
	}
	finally {
		setBusy(false);
	}
}

async function handleReadSelection(): Promise<void> {
	try {
		const ids = await invokeOptional<Array<string>>(
			eda.pcb_SelectControl,
			'getAllSelectedPrimitives_PrimitiveId',
		) ?? [];
		if (ids.length === 0) {
			setStatus('请先在 PCB 画布中框选对象，再读取范围。', true);
			return;
		}

		const bbox = await invokeOptional<{ maxX: number; maxY: number; minX: number; minY: number }>(
			eda.pcb_Primitive,
			'getPrimitivesBBox',
			ids,
		);
		if (!bbox) {
			setStatus('当前 EDA 版本无法计算选中对象的外框，请手工填写坐标。', true);
			return;
		}

		const first = await eda.pcb_Document.convertDataOriginToCanvasOrigin(bbox.minX, bbox.minY);
		const second = await eda.pcb_Document.convertDataOriginToCanvasOrigin(bbox.maxX, bbox.maxY);
		const round = (value: number): string => milToMillimetres(value).toFixed(3);

		input('field-rect-min-x').value = round(Math.min(first.x, second.x));
		input('field-rect-max-x').value = round(Math.max(first.x, second.x));
		input('field-rect-min-y').value = round(Math.min(first.y, second.y));
		input('field-rect-max-y').value = round(Math.max(first.y, second.y));
		setStatus(`已读取 ${ids.length} 个选中对象的外框。`);
	}
	catch (error) {
		setStatus(errorMessage(error), true);
	}
}

async function handleClose(): Promise<void> {
	await invokeOptional(eda.sys_IFrame, 'closeIFrame', PANEL_IFRAME_ID);
}

async function start(): Promise<void> {
	if (typeof eda === 'undefined') {
		setStatus('当前 EDA 版本没有向内联窗口注入扩展 API，请改用菜单里的「快速盗铜（对话框）」。', true);
		setBusy(true);
		return;
	}

	const settings = loadSettings();
	writeForm(settings);

	// 先把控件接上，读图层再慢或失败都不会让面板卡在初始状态。
	select('field-range-mode').addEventListener('change', updateRangeVisibility);
	element('button-generate').addEventListener('click', () => void handleGenerate(false));
	element('button-preview').addEventListener('click', () => void handleGenerate(true));
	element('button-remove').addEventListener('click', () => void handleRemove());
	element('button-remove-all').addEventListener('click', () => void handleRemoveAll());
	element('button-read-selection').addEventListener('click', () => void handleReadSelection());
	element('button-close').addEventListener('click', () => void handleClose());

	setStatus('准备就绪。请先确认目标铜层与参数，再点击生成。');
	await renderLayers(settings.layers);
}

// HTML 里同时保留了外链脚本和内联脚本，用全局标志位保证只初始化一次。
const scope = globalThis as unknown as { __thievingCopperPanelStarted?: boolean };
if (!scope.__thievingCopperPanelStarted) {
	scope.__thievingCopperPanelStarted = true;
	void start().catch((error) => {
		setStatus(errorMessage(error), true);
	});
}
