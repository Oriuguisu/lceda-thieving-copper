const ARC_SEGMENT_ANGLE = Math.PI / 24;
const CORNER_SEGMENTS = 6;
const CURVE_SEGMENTS = 12;
const ELLIPSE_SEGMENTS = 32;

export interface Point {
	x: number;
	y: number;
}

export interface Bounds {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

export function createEmptyBounds(): Bounds {
	return {
		minX: Number.POSITIVE_INFINITY,
		minY: Number.POSITIVE_INFINITY,
		maxX: Number.NEGATIVE_INFINITY,
		maxY: Number.NEGATIVE_INFINITY,
	};
}

export function isUsableBounds(bounds: Bounds): boolean {
	return (
		Number.isFinite(bounds.minX)
		&& Number.isFinite(bounds.minY)
		&& bounds.maxX > bounds.minX
		&& bounds.maxY > bounds.minY
	);
}

export function growBounds(bounds: Bounds, point: Point): void {
	bounds.minX = Math.min(bounds.minX, point.x);
	bounds.minY = Math.min(bounds.minY, point.y);
	bounds.maxX = Math.max(bounds.maxX, point.x);
	bounds.maxY = Math.max(bounds.maxY, point.y);
}

export function boundsOfPoints(points: ReadonlyArray<Point>): Bounds {
	const bounds = createEmptyBounds();
	for (const point of points) {
		growBounds(bounds, point);
	}
	return bounds;
}

export function padBounds(bounds: Bounds, padding: number): Bounds {
	return {
		minX: bounds.minX - padding,
		minY: bounds.minY - padding,
		maxX: bounds.maxX + padding,
		maxY: bounds.maxY + padding,
	};
}

export function rotatePoint(point: Point, origin: Point, degrees: number): Point {
	if (Math.abs(degrees) < 1e-9) {
		return { ...point };
	}
	const angle = degrees * Math.PI / 180;
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	const deltaX = point.x - origin.x;
	const deltaY = point.y - origin.y;
	return {
		x: origin.x + deltaX * cosine - deltaY * sine,
		y: origin.y + deltaX * sine + deltaY * cosine,
	};
}

export function appendPoint(points: Array<Point>, point: Point): void {
	const previous = points.at(-1);
	if (!previous || Math.abs(previous.x - point.x) > 1e-6 || Math.abs(previous.y - point.y) > 1e-6) {
		points.push(point);
	}
}

export function signedArea(points: ReadonlyArray<Point>): number {
	let area = 0;
	for (let index = 0; index < points.length; index += 1) {
		const current = points[index];
		const next = points[(index + 1) % points.length];
		area += current.x * next.y - next.x * current.y;
	}
	return area / 2;
}

export function pointInPolygon(point: Point, polygon: ReadonlyArray<Point>): boolean {
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const current = polygon[index];
		const other = polygon[previous];
		const crosses = (current.y > point.y) !== (other.y > point.y)
			&& point.x < (other.x - current.x) * (point.y - current.y) / (other.y - current.y) + current.x;
		if (crosses) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * 按圆心角采样圆弧。`sweepDegrees` 为带符号扫掠角，正值代表逆时针。
 */
export function appendArcPoints(
	points: Array<Point>,
	start: Point,
	end: Point,
	sweepDegrees: number,
): void {
	const sweep = sweepDegrees * Math.PI / 180;
	const chord = Math.hypot(end.x - start.x, end.y - start.y);
	if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-6 || chord < 1e-9) {
		appendPoint(points, end);
		return;
	}

	const halfSweep = Math.abs(sweep) / 2;
	const radius = chord / (2 * Math.sin(Math.min(halfSweep, Math.PI - 1e-9)));
	if (!Number.isFinite(radius) || radius <= 0) {
		appendPoint(points, end);
		return;
	}

	const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	const height = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
	const normal = { x: -(end.y - start.y) / chord, y: (end.x - start.x) / chord };
	const side = (sweep > 0 ? 1 : -1) * (Math.abs(sweep) > Math.PI ? -1 : 1);
	const center = {
		x: middle.x + normal.x * height * side,
		y: middle.y + normal.y * height * side,
	};

	const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
	const segments = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_SEGMENT_ANGLE));
	for (let index = 1; index <= segments; index += 1) {
		const angle = startAngle + sweep * index / segments;
		appendPoint(points, {
			x: center.x + Math.cos(angle) * radius,
			y: center.y + Math.sin(angle) * radius,
		});
	}
	appendPoint(points, end);
}

export function ellipsePoints(
	center: Point,
	radiusX: number,
	radiusY: number,
	segments = ELLIPSE_SEGMENTS,
): Array<Point> {
	return Array.from({ length: segments }, (_, index) => {
		const angle = index / segments * Math.PI * 2;
		return {
			x: center.x + Math.cos(angle) * radiusX,
			y: center.y + Math.sin(angle) * radiusY,
		};
	});
}

export function rectanglePoints(center: Point, width: number, height: number): Array<Point> {
	const halfWidth = width / 2;
	const halfHeight = height / 2;
	return [
		{ x: center.x - halfWidth, y: center.y - halfHeight },
		{ x: center.x + halfWidth, y: center.y - halfHeight },
		{ x: center.x + halfWidth, y: center.y + halfHeight },
		{ x: center.x - halfWidth, y: center.y + halfHeight },
	];
}

/** 胶囊形（长圆形）焊盘，短边方向的两端为半圆。 */
export function oblongPoints(center: Point, width: number, height: number): Array<Point> {
	const radius = Math.min(width, height) / 2;
	const straightX = Math.max(0, width / 2 - radius);
	const straightY = Math.max(0, height / 2 - radius);
	const points: Array<Point> = [];
	const corners: Array<{ centre: Point; from: number }> = [
		{ centre: { x: center.x + straightX, y: center.y + straightY }, from: 0 },
		{ centre: { x: center.x - straightX, y: center.y + straightY }, from: Math.PI / 2 },
		{ centre: { x: center.x - straightX, y: center.y - straightY }, from: Math.PI },
		{ centre: { x: center.x + straightX, y: center.y - straightY }, from: Math.PI * 1.5 },
	];

	for (const corner of corners) {
		for (let step = 0; step <= 8; step += 1) {
			const angle = corner.from + step / 8 * (Math.PI / 2);
			appendPoint(points, {
				x: corner.centre.x + Math.cos(angle) * radius,
				y: corner.centre.y + Math.sin(angle) * radius,
			});
		}
	}
	return points;
}

function sourceNumber(source: ReadonlyArray<unknown>, index: number): number {
	const value = source[index];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError('EDA 返回的多边形数据包含无效坐标。');
	}
	return value;
}

/**
 * EDA 的矩形源为 `['R', x, y, width, height, rotation, cornerRadius]`，
 * 其中 (x, y) 是左上角，矩形向 y 减小的方向延伸。
 */
function rectangleSourceToPoints(source: ReadonlyArray<unknown>): Array<Point> {
	const x = sourceNumber(source, 1);
	const y = sourceNumber(source, 2);
	const width = sourceNumber(source, 3);
	const height = sourceNumber(source, 4);
	const rotation = typeof source[5] === 'number' ? source[5] : 0;
	const radius = typeof source[6] === 'number'
		? Math.max(0, Math.min(source[6], Math.min(width, height) / 2))
		: 0;
	const center = { x: x + width / 2, y: y - height / 2 };

	if (radius <= 0) {
		return [
			{ x, y },
			{ x: x + width, y },
			{ x: x + width, y: y - height },
			{ x, y: y - height },
		].map(point => rotatePoint(point, center, rotation));
	}

	const points: Array<Point> = [];
	const corners = [
		{ centreX: x + radius, centreY: y - radius, from: 180, to: 90 },
		{ centreX: x + width - radius, centreY: y - radius, from: 90, to: 0 },
		{ centreX: x + width - radius, centreY: y - height + radius, from: 0, to: -90 },
		{ centreX: x + radius, centreY: y - height + radius, from: -90, to: -180 },
	];
	for (const corner of corners) {
		for (let step = 0; step <= CORNER_SEGMENTS; step += 1) {
			const angle = (corner.from + (corner.to - corner.from) * step / CORNER_SEGMENTS) * Math.PI / 180;
			appendPoint(points, {
				x: corner.centreX + Math.cos(angle) * radius,
				y: corner.centreY + Math.sin(angle) * radius,
			});
		}
	}
	return points.map(point => rotatePoint(point, center, rotation));
}

function cubicCurveToPoints(
	points: Array<Point>,
	start: Point,
	control1: Point,
	control2: Point,
	end: Point,
): void {
	for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
		const t = step / CURVE_SEGMENTS;
		const inverse = 1 - t;
		appendPoint(points, {
			x: inverse ** 3 * start.x
				+ 3 * inverse ** 2 * t * control1.x
				+ 3 * inverse * t ** 2 * control2.x
				+ t ** 3 * end.x,
			y: inverse ** 3 * start.y
				+ 3 * inverse ** 2 * t * control1.y
				+ 3 * inverse * t ** 2 * control2.y
				+ t ** 3 * end.y,
		});
	}
}

/**
 * 将 EDA 的单多边形数据离散为点序列。
 *
 * @remarks 无法识别的路径命令会退化为直线连接，宁可少绕路也不要抛错中断整块板的分析。
 */
export function polygonSourceToPoints(source: ReadonlyArray<unknown>): Array<Point> {
	if (source.length === 0) {
		return [];
	}
	if (source[0] === 'R') {
		return rectangleSourceToPoints(source);
	}
	if (source[0] === 'CIRCLE') {
		return ellipsePoints(
			{ x: sourceNumber(source, 1), y: sourceNumber(source, 2) },
			sourceNumber(source, 3),
			sourceNumber(source, 3),
		);
	}
	if (typeof source[0] !== 'number' || typeof source[1] !== 'number') {
		return [];
	}

	let current: Point = { x: source[0], y: source[1] };
	const points: Array<Point> = [{ ...current }];
	let command = 'L';
	let index = 2;

	while (index < source.length) {
		if (typeof source[index] === 'string') {
			command = source[index] as string;
			index += 1;
			continue;
		}

		if (command === 'C') {
			const control1 = { x: sourceNumber(source, index), y: sourceNumber(source, index + 1) };
			const control2 = { x: sourceNumber(source, index + 2), y: sourceNumber(source, index + 3) };
			const end = { x: sourceNumber(source, index + 4), y: sourceNumber(source, index + 5) };
			cubicCurveToPoints(points, current, control1, control2, end);
			current = end;
			index += 6;
		}
		else if (command === 'ARC' || command === 'CARC') {
			const sweep = sourceNumber(source, index);
			const end = { x: sourceNumber(source, index + 1), y: sourceNumber(source, index + 2) };
			appendArcPoints(points, current, end, command === 'CARC' ? -sweep : sweep);
			current = end;
			index += 3;
		}
		else {
			const end = { x: sourceNumber(source, index), y: sourceNumber(source, index + 1) };
			appendPoint(points, end);
			current = end;
			index += 2;
		}
	}

	return points;
}

export function complexPolygonToPaths(polygon: unknown): Array<Array<Point>> {
	if (!polygon) {
		return [];
	}

	const candidate = polygon as {
		getSourceStrictComplex?: () => Array<Array<unknown>>;
		getSource?: () => Array<unknown>;
	};
	if (typeof candidate.getSourceStrictComplex === 'function') {
		return candidate.getSourceStrictComplex()
			.map(source => polygonSourceToPoints(source))
			.filter(points => points.length >= 3);
	}
	if (typeof candidate.getSource === 'function') {
		const source = candidate.getSource();
		if (Array.isArray(source) && Array.isArray(source[0])) {
			return (source as Array<Array<unknown>>)
				.map(item => polygonSourceToPoints(item))
				.filter(points => points.length >= 3);
		}
		const points = polygonSourceToPoints(source);
		return points.length >= 3 ? [points] : [];
	}
	return [];
}
