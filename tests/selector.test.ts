// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { uniqueSelector } from '../lib/selector';
import { camelToKebab, gsapPropsToCss } from '../lib/css-props';

describe('uniqueSelector', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main id="app">
        <section class="grid">
          <div class="card">a</div>
          <div class="card">b</div>
          <div class="card featured">c</div>
        </section>
        <button class="css-1x2y3z4">go</button>
        <span id="solo"></span>
      </main>`;
  });

  it('uses a unique id', () => {
    expect(uniqueSelector(document.getElementById('solo')!)).toBe('#solo');
  });

  it('uses unique classes', () => {
    expect(uniqueSelector(document.querySelector('.featured')!)).toBe('div.card.featured');
  });

  it('falls back to an nth-of-type path that resolves to the element', () => {
    const el = document.querySelectorAll('.card')[1]!;
    const sel = uniqueSelector(el);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)).toBe(el);
    expect(sel).toContain(':nth-of-type(2)');
  });

  it('skips hashed class names and appends pseudo-elements', () => {
    const sel = uniqueSelector(document.querySelector('button')!, '::after');
    expect(sel).not.toContain('css-1x2y3z4');
    expect(sel.endsWith('::after')).toBe(true);
  });
});

describe('css-props', () => {
  it('kebab-cases WAAPI names and keeps custom properties', () => {
    expect(camelToKebab('backgroundColor')).toBe('background-color');
    expect(camelToKebab('--my-var')).toBe('--my-var');
  });

  it('folds GSAP shorthands into transform', () => {
    expect(gsapPropsToCss({ x: '100', y: '-20', rotation: '45', autoAlpha: '1', width: '10' })).toEqual({
      transform: 'translateX(100px) translateY(-20px) rotate(45deg)',
      opacity: '1',
      width: '10px',
    });
  });
});
