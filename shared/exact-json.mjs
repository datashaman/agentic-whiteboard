export function supportsExactJSON() {
  return typeof JSON.rawJSON === 'function' && typeof JSON.isRawJSON === 'function';
}

export function parseExactJSON(text, unsupported = 'This runtime cannot preserve exact JSON numbers.') {
  const supported = supportsExactJSON();
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (!supported || context?.source === undefined) throw new Error(unsupported);
    // Keep the source token so JSON.stringify can forward the exact number.
    return JSON.rawJSON(context.source);
  });
}

export function numberText(value) {
  return JSON.isRawJSON?.(value) ? value.rawJSON : '';
}
