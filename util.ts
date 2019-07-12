export const makeArray = <A>(len: number, init: (index: number) => A): A[] =>
	new Array(len).fill(0).map((_, i) => init(i))
export function* reverse<A>(arr: A[]): IterableIterator<A> {
	for (let i = arr.length - 1; i >= 0; i--) yield arr[i]
}

export function convertFloatToInt(value: number, wide: boolean): number | bigint {
	const dataView = new DataView(new ArrayBuffer(wide ? 8 : 4))
	if (wide) dataView.setFloat64(0, value, true)
	else dataView.setFloat32(0, value, true)
	return wide ? dataView.getBigUint64(0, true) : dataView.getUint32(0, true)
}