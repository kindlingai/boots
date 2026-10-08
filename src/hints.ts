// Hints by output: when a command's output matches one of the patterns in
// hints.json, the result carries that hint ([hint: ...]), to steer the model
// without refusing anything. Edit hints.json to add or change them.

import data from "./hints.json" with { type: "json" };

export type HintTool = "run" | "sudo" | "run_playbook";

export interface OutputHint {
  tools?: HintTool[];
  command?: string;
  output: string;
  hint: string;
}

interface Compiled {
  tools: Set<string> | null;
  command: RegExp | null;
  output: RegExp;
  hint: string;
}

/** The hints in a hints.json-shaped object; throws on a bad entry. */
export function compileHints(entries: OutputHint[]): Compiled[] {
  return entries.map((h, i) => {
    if (typeof h?.output !== "string" || typeof h?.hint !== "string" || !h.hint.trim()) {
      throw new Error(`hints.json entry ${i}: needs output and hint`);
    }
    return {
      tools: h.tools?.length ? new Set(h.tools) : null,
      command: h.command ? new RegExp(h.command, "i") : null,
      output: new RegExp(h.output, "i"),
      hint: h.hint.trim(),
    };
  });
}

const HINTS = compileHints((data as { hints: OutputHint[] }).hints);

/** The hints for a tool's command and its output, each once. */
export function outputHints(
  tool: HintTool,
  command: string,
  output: string,
  hints: Compiled[] = HINTS,
): string[] {
  return [
    ...new Set(
      hints.filter((h) =>
        (!h.tools || h.tools.has(tool)) && (!h.command || h.command.test(command)) &&
        h.output.test(output)
      ).map((h) => h.hint),
    ),
  ];
}
