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

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
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

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  const normalized = selector.replace(/:not\([^)]*\)/g, "");
  const tag = normalized.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  const id = normalized.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && element.getAttribute("id") !== id) return false;

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
