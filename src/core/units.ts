/** 嘉立创 EDA 的数据坐标单位为 mil，界面参数统一使用毫米。 */
export const MILLIMETRES_PER_MIL = 0.0254;

export function millimetresToMil(value: number): number {
	return value / MILLIMETRES_PER_MIL;
}

export function milToMillimetres(value: number): number {
	return value * MILLIMETRES_PER_MIL;
}
