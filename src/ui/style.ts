// ANSI styling. Colors turn off for NO_COLOR and when the output is not a terminal.

const CODES = {
	bold: [1, 22],
	dim: [2, 22],
	italic: [3, 23],
	underline: [4, 24],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	gray: [90, 39],
} as const;

export type StyleName = keyof typeof CODES;

export type Paint = (text: string, ...styles: StyleName[]) => string;

export function painter(enabled: boolean): Paint {
	if (!enabled) return (text) => text;
	return (text, ...styles) => styles.reduce((out, style) => `\x1b[${CODES[style][0]}m${out}\x1b[${CODES[style][1]}m`, text);
}

export function colorEnabled(stream: NodeJS.WriteStream): boolean {
	return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;
}
