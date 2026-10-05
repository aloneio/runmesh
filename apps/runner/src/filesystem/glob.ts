type GlobToken = { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "one" | "segment" | "tree" | "directories" | "descendants" };

export interface PathGlob {
  readonly pattern: string;
  readonly identity: string;
  test(path: string): boolean;
}

interface GlobOptions {
  readonly caseSensitive: boolean;
  readonly directoryPrefix?: string;
  readonly matchBasename?: boolean;
  readonly matchDescendants?: boolean;
}

/** Compile bounded glob syntax without regular-expression backtracking.
 * Matching uses two input-length state rows: O(pattern * path) time and
 * O(path) working space, including patterns with many overlapping stars. */
export function compilePathGlob(pattern: string, options: GlobOptions): PathGlob {
  const tokens: GlobToken[] = [];
  const literal = (value: string): void => { tokens.push({ kind: "literal", value: canonicalCharacter(value, options.caseSensitive) }); };
  if (options.directoryPrefix) for (const value of `${options.directoryPrefix}/`) literal(value);
  if (options.matchBasename) appendWildcard(tokens, "directories");
  const characters = Array.from(pattern);
  for (let index = 0; index < characters.length; index += 1) {
    const value = characters[index]!;
    if (value === "*") {
      const start = index;
      while (characters[index + 1] === "*") index += 1;
      if (index > start) {
        if (characters[index + 1] === "/") { index += 1; appendWildcard(tokens, "directories"); }
        else appendWildcard(tokens, "tree");
      } else appendWildcard(tokens, "segment");
    } else if (value === "?") tokens.push({ kind: "one" });
    else literal(value);
  }
  if (options.matchDescendants) tokens.push({ kind: "descendants" });
  const minimumLength = tokens.filter(token => token.kind === "literal" || token.kind === "one").length;
  return {
    pattern,
    identity: JSON.stringify([pattern, options.caseSensitive, options.directoryPrefix ?? "", options.matchBasename === true, options.matchDescendants === true]),
    test: (path) => {
      const input = Array.from(path, value => canonicalCharacter(value, options.caseSensitive));
      if (minimumLength > input.length) return false;
      let current = new Uint8Array(input.length + 1), next = new Uint8Array(input.length + 1);
      current[0] = 1;
      for (const token of tokens) {
        next.fill(0);
        let matchedEarlier = false;
        for (let index = 0; index <= input.length; index += 1) {
          const previous = index > 0 ? input[index - 1] : undefined;
          if (token.kind === "literal" || token.kind === "one") {
            if (index > 0 && current[index - 1] && (token.kind === "literal" ? previous === token.value : previous !== "/")) next[index] = 1;
          } else if (token.kind === "segment" || token.kind === "tree") {
            if (current[index] || index > 0 && next[index - 1] && (token.kind === "tree" || previous !== "/")) next[index] = 1;
          } else if (token.kind === "directories") {
            // **/ either consumes nothing or a prefix ending with '/'. A
            // partial directory name cannot take the empty transition.
            if (current[index] || matchedEarlier && previous === "/") next[index] = 1;
            matchedEarlier ||= current[index] === 1;
          } else {
            // Optional descendants start with '/' and then consume any path.
            matchedEarlier ||= index > 0 && current[index - 1] === 1 && previous === "/";
            if (current[index] || matchedEarlier) next[index] = 1;
          }
        }
        [current, next] = [next, current];
      }
      return current[input.length] === 1;
    },
  };
}

function appendWildcard(tokens: GlobToken[], kind: "segment" | "tree" | "directories"): void {
  // Long ignore lines may contain thousands of zero-width **/ groups. Merge
  // equivalent adjacent wildcards before matching, keeping required literal
  // and '?' boundaries intact. A directory prefix plus its last segment is
  // exactly a full-path star; the reverse order has different semantics.
  for (;;) {
    const previous = tokens.at(-1)?.kind;
    if (previous !== "segment" && previous !== "tree" && previous !== "directories") break;
    if (previous === kind) tokens.pop();
    else if (previous === "tree" || kind === "tree" || previous === "directories" && kind === "segment") {
      tokens.pop(); kind = "tree";
    } else break;
  }
  tokens.push({ kind });
}

function canonicalCharacter(value: string, caseSensitive: boolean): string {
  if (caseSensitive) return value;
  // Preserve the existing platform /i literal comparison. Uppercasing a
  // whole path would expand characters and change what one '?' consumes.
  const upper = value.toUpperCase();
  return upper.length !== 1 || value.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? value : upper;
}
