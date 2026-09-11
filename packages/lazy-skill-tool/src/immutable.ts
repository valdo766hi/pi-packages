class ImmutableMapView<K, V> implements ReadonlyMap<K, V> {
	readonly #source: Map<K, V>;

	constructor(entries: Iterable<readonly [K, V]>) {
		this.#source = new Map(entries);
		Object.freeze(this);
	}

	get size(): number {
		return this.#source.size;
	}

	entries(): MapIterator<[K, V]> {
		return this.#source.entries();
	}

	get(key: K): V | undefined {
		return this.#source.get(key);
	}

	has(key: K): boolean {
		return this.#source.has(key);
	}

	keys(): MapIterator<K> {
		return this.#source.keys();
	}

	values(): MapIterator<V> {
		return this.#source.values();
	}

	forEach(
		callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
		thisArgument?: unknown,
	): void {
		this.#source.forEach((value, key) =>
			callback.call(thisArgument, value, key, this),
		);
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.#source[Symbol.iterator]();
	}
}

class ImmutableSetView<T> implements ReadonlySet<T> {
	readonly #source: Set<T>;

	constructor(values: Iterable<T>) {
		this.#source = new Set(values);
		Object.freeze(this);
	}

	get size(): number {
		return this.#source.size;
	}

	entries(): SetIterator<[T, T]> {
		return this.#source.entries();
	}

	has(value: T): boolean {
		return this.#source.has(value);
	}

	keys(): SetIterator<T> {
		return this.#source.keys();
	}

	values(): SetIterator<T> {
		return this.#source.values();
	}

	forEach(
		callback: (value: T, valueAgain: T, set: ReadonlySet<T>) => void,
		thisArgument?: unknown,
	): void {
		this.#source.forEach((value) =>
			callback.call(thisArgument, value, value, this),
		);
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.#source[Symbol.iterator]();
	}
}

export function immutableMap<K, V>(
	entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
	return new ImmutableMapView(entries);
}

export function immutableSet<T>(values: Iterable<T>): ReadonlySet<T> {
	return new ImmutableSetView(values);
}
