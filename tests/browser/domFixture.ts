export class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[];
  readonly tagName: string;

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: FakeElement[] = [],
    private readonly ownText = "",
  ) {
    this.tagName = tagName.toUpperCase();
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get classList() {
    return {
      contains: (value: string) => (this.getAttribute("class") ?? "").split(/\s+/).includes(value),
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  get isConnected(): boolean {
    return this.tagName === "BODY" || this.parentElement?.isConnected === true;
  }

  getBoundingClientRect() {
    return { width: 100, height: 20 };
  }

  append(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
  }

  remove() {
    const index = this.parentElement?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentElement?.children.splice(index, 1);
    this.parentElement = null;
  }

  get innerText(): string {
    return this.textContent;
  }

  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  contains(element: FakeElement): boolean {
    return this === element || this.children.some((child) => child.contains(element));
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  compareDocumentPosition(other: FakeElement): number {
    if (other === this) return 0;
    const a = treePath(this);
    const b = treePath(other);
    if (a.root !== b.root) return 1;
    if (b.path.length > a.path.length && a.path.every((step, i) => step === b.path[i])) return 20;
    if (a.path.length > b.path.length && b.path.every((step, i) => step === a.path[i])) return 10;
    const i = a.path.findIndex((step, index) => step !== b.path[index]);
    return b.path[i] > a.path[i] ? 4 : 2;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return flattenElements(this.children).filter((element) => matchesSelector(element, selector));
  }
}

export class FakeInputElement extends FakeElement {
  constructor(readonly files: Array<{ name: string }>) {
    super("input", { type: "file" });
  }
}

export class FakeDocument {
  readonly body: FakeElement;

  constructor(children: FakeElement[]) {
    this.body = new FakeElement("body", {}, children);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
}

function flattenElements(elements: FakeElement[]): FakeElement[] {
  return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
}

function treePath(element: FakeElement): { root: FakeElement; path: number[] } {
  const path: number[] = [];
  let node = element;
  while (node.parentElement) {
    path.unshift(node.parentElement.children.indexOf(node));
    node = node.parentElement;
  }
  return { root: node, path };
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return splitSelector(selector, ",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  const compounds = splitSelector(selector, " ");
  if (compounds.length > 1) {
    if (!matchesSingleSelector(element, compounds.at(-1)!)) return false;
    let ancestor = element.parentElement;
    while (ancestor) {
      if (matchesSingleSelector(ancestor, compounds.slice(0, -1).join(" "))) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }
  let rejected = false;
  const normalized = selector.replace(/:(is|not)\(([^()]*)\)/g, (_match, kind, choices) => {
    const matches = matchesSelector(element, choices);
    if ((kind === "is" && !matches) || (kind === "not" && matches)) rejected = true;
    return "";
  });
  if (rejected) return false;
  if (normalized.includes(":disabled") && !element.hasAttribute("disabled")) return false;
  for (const match of normalized.replace(/\[[^\]]*\]/g, "").matchAll(/\.([a-z0-9_-]+)/gi)) {
    if (!(element.getAttribute("class") ?? "").split(/\s+/).includes(match[1]!)) return false;
  }
  const tag = normalized.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  const id = normalized.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && element.getAttribute("id") !== id) return false;

  const classes = (element.getAttribute("class") ?? "").split(/\s+/);
  for (const match of normalized.replace(/\[[^\]]*\]/g, "").matchAll(/\.([a-z0-9_-]+)/gi)) {
    if (!classes.includes(match[1])) return false;
  }

  const attrPattern = /\[([^\]\s~|^$*!=]+)([*^$~]?=)?(?:"([^"]*)"|'([^']*)')?\s*(i)?\]/g;
  for (const match of normalized.matchAll(attrPattern)) {
    const [, name, operator, doubleQuotedValue, singleQuotedValue, insensitive] = match;
    const expected = doubleQuotedValue ?? singleQuotedValue ?? "";
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    const equal = insensitive
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
    if (operator === "=" && !equal) return false;
    if (operator === "~=" && !actual.split(/\s+/).includes(expected)) return false;
    if (operator === "*=" && !actual.toLowerCase().includes(expected.toLowerCase())) return false;
    if (operator === "^=" && !actual.toLowerCase().startsWith(expected.toLowerCase())) return false;
    if (operator === "$=" && !actual.toLowerCase().endsWith(expected.toLowerCase())) return false;
  }
  return true;
}

// Browser fixture selectors include commas inside :is() and spaces inside aria labels.
// Split only at CSS list/descendant boundaries, not inside those scopes.
function splitSelector(selector: string, separator: string): string[] {
  let depth = 0;
  let quote = "";
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!;
    if (quote) {
      if (char === quote && selector[i - 1] !== "\\") quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === separator && depth === 0) {
      const part = selector.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const last = selector.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}
