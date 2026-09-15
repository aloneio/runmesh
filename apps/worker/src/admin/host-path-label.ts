

export function isFullHostPath(value: string): boolean { return value === "/" || /^[A-Za-z]:[\\/]?$/.test(value); }
