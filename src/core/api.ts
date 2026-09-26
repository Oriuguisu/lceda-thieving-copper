/**
 * 调用可能在当前 EDA 版本里并不存在的接口。
 *
 * @remarks
 * 扩展 API 会随版本增删，缺失的方法在调用时同步抛 `TypeError`，光靠 Promise 的
 * `catch` 兜不住，会直接打断整个流程。统一走这里：方法不存在或调用失败都返回
 * `undefined`，由调用方决定退化行为。
 */
export async function invokeOptional<T>(
	target: unknown,
	method: string,
	...args: Array<unknown>
): Promise<T | undefined> {
	const holder = target as Record<string, unknown> | null | undefined;
	const candidate = holder?.[method];
	if (typeof candidate !== 'function') {
		return undefined;
	}

	try {
		return await (candidate as (...items: Array<unknown>) => Promise<T>).apply(holder, args);
	}
	catch {
		return undefined;
	}
}

export function hasMethod(target: unknown, method: string): boolean {
	return typeof (target as Record<string, unknown> | null | undefined)?.[method] === 'function';
}
