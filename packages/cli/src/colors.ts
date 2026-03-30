// Chalk-compatible ANSI color helper — zero dependencies
// Supports: c.green("x"), c.bold.green("x"), c.green.bold("x")

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

type Styler = ((text: string) => string) & {
  bold:   Styler;
  dim:    Styler;
  red:    Styler;
  green:  Styler;
  yellow: Styler;
  blue:   Styler;
  cyan:   Styler;
  white:  Styler;
  gray:   Styler;
};

function make(codes: number[]): Styler {
  const open = codes.map(c => `${ESC}${c}m`).join("");
  const fn = (text: string) => `${open}${text}${RESET}`;
  return new Proxy(fn, {
    get(_t, prop: string) {
      const extra: Record<string, number> = {
        bold: 1, dim: 2,
        red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, white: 37, gray: 90,
      };
      if (prop in extra) return make([...codes, extra[prop]]);
      return undefined;
    },
  }) as Styler;
}

const c = new Proxy((() => {}) as unknown as Styler, {
  get(_t, prop: string) {
    const map: Record<string, number> = {
      bold: 1, dim: 2,
      red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, white: 37, gray: 90,
    };
    if (prop in map) return make([map[prop]]);
    return undefined;
  },
}) as Styler;

export default c;
