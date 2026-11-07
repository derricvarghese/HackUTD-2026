/**
 * Canonical JSON used for every signature in Beacon:
 *  - object keys sorted ascending by UTF-16 code unit (default JS sort), recursively
 *  - no whitespace
 *  - strings/numbers/booleans/null encoded exactly like ECMAScript JSON.stringify
 *  - arrays keep their order; `undefined` values are an error (omit the key instead)
 * See docs/crypto.md.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return (
        '{' +
        keys
          .map((k) => {
            if (obj[k] === undefined) throw new Error(`canonicalJson: undefined value at key ${k}`);
            return JSON.stringify(k) + ':' + canonicalJson(obj[k]);
          })
          .join(',') +
        '}'
      );
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}
