// Shared checks for the library contract and the pending consumer migration.
const namedColours = 'white|black|gr[ae]y|red|green|blue|gold|teal|orange|navy|purple|pink|yellow|brown|silver|maroon|olive|lime|aqua|cyan|magenta|crimson|coral|beige|ivory|indigo|violet';
const palette = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\\(|(?<![\\w-])(?:${namedColours})(?![\\w-])|\\b(?:Arial|Georgia|Helvetica|system-ui|sans-serif|serif|monospace)\\b|font-family\\s*:\\s*['"]|--sp-[a-z0-9-]+\\s*:`, 'gi');
/** Colour/font literals that would make a primitive carry its own palette, and `--sp-*` overrides. Run it on CSS outside `themeCss`. */
export function paletteLiterals(css: string): string[] {
  return css.match(palette) ?? [];
}
