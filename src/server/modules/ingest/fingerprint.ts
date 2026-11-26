/**
 * Error fingerprinting.
 *
 * The product question is "is this the same bug as yesterday", and the answer
 * has to survive what changes on every occurrence: request ids, timestamps, ids
 * in the message, memory addresses. So the message is normalized before it is
 * hashed, and the top application frame is part of the key — two
 * `TypeError: x is not a function` thrown from different files are different
 * bugs.
 *
 * `node_modules` and runtime internals are excluded from the frame: a stack that
 * bottoms out in the framework says nothing about where the user's code broke.
 */
import { createHash } from "node:crypto";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID = /\b[0-9a-f]{16,}\b/gi;
const NUMBER = /\b\d+(\.\d+)?\b/g;
const QUOTED = /(['"`])(?:\\.|(?!\1).)*\1/g;
const WHITESPACE = /\s+/g;

/** Messages are compared without the parts that vary between occurrences. */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID, "<uuid>")
    .replace(HEX_ID, "<hex>")
    .replace(QUOTED, "<str>")
    .replace(NUMBER, "<n>")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, 500);
}

export interface StackFrame {
  readonly file: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly fn: string | null;
  readonly inApp: boolean;
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?((?:[a-zA-Z]:)?[^():]+?):(\d+):(\d+)\)?$/;

/**
 * Parses V8 stack frames. `inApp` is a heuristic on purpose: the collector
 * usually runs somewhere else entirely, so it cannot resolve a source map or
 * touch the filesystem — it can only read what the stack says.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const match = FRAME.exec(raw);
    if (!match) continue;
    const [, fn, file, line, column] = match;
    if (!file) continue;
    const path = file.trim();
    frames.push({
      file: path,
      line: line ? Number(line) : null,
      column: column ? Number(column) : null,
      fn: fn ?? null,
      inApp: isInApp(path),
    });
  }
  return frames;
}

export function isInApp(file: string): boolean {
  if (file.includes("node_modules")) return false;
  if (file.startsWith("node:")) return false;
  if (file.startsWith("internal/")) return false;
  if (file.startsWith("bun:")) return false;
  return true;
}

export interface Fingerprint {
  readonly fingerprint: string;
  readonly message: string;
  readonly class: string | undefined;
  readonly topFrame: StackFrame | undefined;
}

export function fingerprint(input: {
  message: string;
  class?: string;
  stack?: string;
}): Fingerprint {
  const topFrame = parseStack(input.stack).find((frame) => frame.inApp);
  const normalized = normalizeMessage(input.message);
  const key = [
    input.class ?? "",
    normalized,
    topFrame ? `${topFrame.file}:${topFrame.fn ?? ""}` : "",
  ].join("\u0000");

  return {
    fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 32),
    message: input.message.slice(0, 2000),
    class: input.class,
    topFrame,
  };
}

/**
 * What the collector keeps of a stack. A runaway stack (recursive error
 * construction) is the usual way one entry blows the batch's size budget.
 */
export function trimStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  return lines.length > 64 ? lines.slice(0, 64).join("\n") : stack;
}
