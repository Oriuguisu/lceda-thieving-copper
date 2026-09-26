export const PANEL_IFRAME_ID = 'lceda-thieving-copper-panel';
export const PANEL_HTML_PATH = '/iframe/index.html';
export const PANEL_WIDTH = 580;
export const PANEL_HEIGHT = 760;

/** 让出主线程，长时间的同步计算之间调用一次，界面才有机会刷新进度。 */
export function yieldToUi(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}
