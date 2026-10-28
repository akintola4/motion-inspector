// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { elementLabel, isUtilityClass } from '../lib/label';

describe('elementLabel', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <article class="h-full flex flex-col card">
        <div class="h-4 w-full animate-pulse rounded-md bg-gray-200"></div>
        <a class="text-sm hover:underline" href="#">Read more</a>
        <button aria-label="Close menu" class="p-2"><svg></svg></button>
      </article>
      <section id="hero" class="mt-[12px]"></section>
      <div class="Card_root__a1B2c"></div>
      <nav><button class="chip">Design</button><button class="chip">Motion</button></nav>
      <div class="box blue m-spring"></div><div class="box"></div>
      <div id=":r1:" class="px-4"><span class="dot"></span><span class="dot"></span></div>
    `;
  });

  it('prefers aria-label, then id', () => {
    expect(elementLabel(document.querySelector('button')!)).toBe('button “Close menu”');
    expect(elementLabel(document.getElementById('hero')!)).toBe('#hero');
  });

  it('skips Tailwind utilities and names by meaningful class', () => {
    expect(elementLabel(document.querySelector('article')!)).toBe('article.card');
    expect(elementLabel(document.querySelector('.dot')!)).toBe('span.dot');
  });

  it('prefers the most descriptive unique class', () => {
    expect(elementLabel(document.querySelector('.m-spring')!)).toBe('div.m-spring');
  });

  it('adds text when a class is shared', () => {
    expect(elementLabel(document.querySelectorAll('.chip')[1]!)).toBe('button.chip “Motion”');
  });

  it('uses short text when there is no class worth showing', () => {
    expect(elementLabel(document.querySelector('a')!)).toBe('a “Read more”');
  });

  it('falls back to the nearest named ancestor', () => {
    expect(elementLabel(document.querySelector('.animate-pulse')!)).toBe('div in article.card');
  });

  it('tidies CSS-module names and appends pseudo-elements', () => {
    expect(elementLabel(document.querySelector('.Card_root__a1B2c')!, '::after')).toBe('div.Card_root::after');
  });

  it('ignores generated ids', () => {
    expect(elementLabel(document.querySelector('[id=":r1:"]')!)).toBe('div');
  });
});

describe('isUtilityClass', () => {
  it('knows common utilities from component classes', () => {
    for (const c of ['flex', 'h-full', 'animate-pulse', 'md:grid', 'bg-gray-200', 'w-1/2', 'rounded', 'group']) {
      expect(isUtilityClass(c), c).toBe(true);
    }
    for (const c of ['card', 'skeleton', 'toast', 'toggle', 'm-spring', 'hero-title']) {
      expect(isUtilityClass(c), c).toBe(false);
    }
  });
});
