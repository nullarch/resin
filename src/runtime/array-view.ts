// array.slice returns a view, not a copy: "a shallow copy of an array's slice ... changes to the
// slice also affect the original array" (Pine reference, array.slice). What that means exactly is
// measured (oracle pynecore utils/sequence_view.py, "Measured on TradingView (FX:EURUSD 240) with
// array.slice(a, 0, 2) on [10, 20, 30, 40]"; tier 1 array_002_array_functions and
// array_003_array_functions_float: `array.set(sa, 1, 11)` on `sa = array.slice(a, 1, 3)` shows in
// `a`):
//   - a view is a plain index range [start, stop) over the parent, and every mutation of the view
//     writes through inside the view's own bounds: a push lands at the slice end (parent index 2,
//     giving 10, 20, 99, 30, 40), a pop takes the slice's last element (20, not the parent's 40),
//     and clear() cuts the sliced elements out of the parent;
//   - the stored range never follows the parent's content: removing the parent's first element
//     leaves the [0, 2) view showing 20, 30. It is only clipped to the parent's current length,
//     and not for good: a view shrunk to nothing comes back when the parent grows past its start.
//
// The view is a Proxy that looks like an array to everything else in the runtime: indices and
// `length` are answered from the parent, and the Array.prototype methods run their generic
// algorithms over those two, so sort, reverse, fill, push, pop, splice and iteration all write
// through without knowing about views. Array.isArray is true for it.

const INDEX = /^(?:0|[1-9]\d*)$/;

export function sliceView<T>(parent: T[], from: number, to: number): T[] {
  const start = Math.max(0, Math.min(from < 0 ? parent.length + from : from, parent.length));
  let stop = Math.max(start, Math.min(to, parent.length));
  const len = (): number => Math.max(0, Math.min(stop, parent.length) - start);

  const setLength = (n: number): void => {
    const cur = len();
    if (n < cur) {
      parent.splice(start + n, cur - n);
      stop = start + n;
    } else if (n > cur) {
      // Array algorithms grow by writing the new index first; a bare length growth pads with na.
      parent.splice(start + cur, 0, ...(new Array(n - cur).fill(NaN) as T[]));
      stop = start + n;
    }
  };

  return new Proxy([] as T[], {
    get(target, prop, receiver) {
      if (prop === "length") return len();
      if (typeof prop === "string" && INDEX.test(prop)) {
        const i = Number(prop);
        return i < len() ? parent[start + i] : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === "length") {
        setLength(Number(value));
        return true;
      }
      if (typeof prop === "string" && INDEX.test(prop)) {
        const i = Number(prop);
        const cur = len();
        if (i < cur) {
          parent[start + i] = value as T;
        } else {
          if (i > cur) setLength(i);
          parent.splice(start + i, 0, value as T);
          stop = start + i + 1;
        }
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && INDEX.test(prop)) return Number(prop) < len();
      return Reflect.has(target, prop);
    },
    // The generic algorithms delete the tail before they shorten `length`; the shortening is what
    // removes the elements from the parent.
    deleteProperty(target, prop) {
      if (typeof prop === "string" && INDEX.test(prop)) return true;
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys() {
      const keys: string[] = [];
      for (let i = 0; i < len(); i++) keys.push(String(i));
      keys.push("length");
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "length") return { value: len(), writable: true, enumerable: false, configurable: false };
      if (typeof prop === "string" && INDEX.test(prop)) {
        const i = Number(prop);
        return i < len() ? { value: parent[start + i], writable: true, enumerable: true, configurable: true } : undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}
