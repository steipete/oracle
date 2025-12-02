import { describe, expect, test } from 'vitest';
import { buildAttachmentPlan, buildCookiePlan } from '../../src/browser/policies.js';
import { formatFileSection } from '../../src/oracle/markdown.js';

const sections = [
  { displayPath: 'a.txt', absolutePath: '/repo/a.txt', content: 'hello' },
  { displayPath: 'b.txt', absolutePath: '/repo/b.txt', content: 'world' },
];

describe('buildAttachmentPlan', () => {
  test('inlines files when requested', () => {
    const plan = buildAttachmentPlan(sections, { inlineFiles: true, bundleRequested: false, maxAttachments: 10 });
    expect(plan.mode).toBe('inline');
    expect(plan.inlineFileCount).toBe(2);
    expect(plan.attachments).toHaveLength(0);
    expect(plan.shouldBundle).toBe(false);
    expect(plan.inlineBlock).toContain('### File: a.txt');
    expect(plan.inlineBlock).toContain(formatFileSection('b.txt', 'world').trim());
  });

  test('bundles when over max attachments', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      displayPath: `f${i}.txt`,
      absolutePath: `/repo/f${i}.txt`,
      content: 'x',
    }));
    const plan = buildAttachmentPlan(many, { inlineFiles: false, bundleRequested: false, maxAttachments: 10 });
    expect(plan.mode).toBe('bundle');
    expect(plan.shouldBundle).toBe(true);
    expect(plan.attachments).toHaveLength(11);
  });

  test('forces bundle when requested even under threshold', () => {
    const plan = buildAttachmentPlan(sections, { inlineFiles: false, bundleRequested: true, maxAttachments: 10 });
    expect(plan.shouldBundle).toBe(true);
    expect(plan.mode).toBe('bundle');
  });
});

describe('buildCookiePlan', () => {
  test('inline cookies plan', () => {
    const plan = buildCookiePlan({
      inlineCookies: [{ name: 'a', value: '1' }],
      inlineCookiesSource: 'test',
    });
    expect(plan.type).toBe('inline');
    expect(plan.description).toContain('inline payload (1) via test');
  });

  test('disabled cookie sync plan', () => {
    const plan = buildCookiePlan({ cookieSync: false });
    expect(plan.type).toBe('disabled');
    expect(plan.description).toContain('Profile sync: disabled');
  });

  test('copy from Chrome default allowlist', () => {
    const plan = buildCookiePlan({});
    expect(plan.type).toBe('profile');
    expect(plan.description).toContain('Profile sync: copy Chrome profile (Default)');
  });
});
