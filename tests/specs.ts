import type { AnimationSpec } from '../lib/types';
import { springToLinear } from '../lib/easing';

const base = {
  delay: 0,
  endDelay: 0,
  iterations: 1,
  direction: 'normal',
  fill: 'none',
  easing: 'linear',
} as const;

export const transition: AnimationSpec = {
  ...base,
  id: 't1',
  kind: 'css-transition',
  name: 'background-color',
  selector: '.button',
  duration: 200,
  easing: 'ease-out',
  keyframes: [
    { offset: 0, easing: 'linear', props: { backgroundColor: 'rgb(255, 255, 255)' } },
    { offset: 1, easing: 'linear', props: { backgroundColor: 'rgb(0, 112, 243)' } },
  ],
  properties: ['backgroundColor'],
};

export const cssKeyframes: AnimationSpec = {
  ...base,
  id: 'c1',
  kind: 'css-animation',
  name: 'pulse',
  selector: '#card',
  duration: 1200,
  delay: 100,
  iterations: 'infinite',
  direction: 'alternate',
  fill: 'both',
  keyframes: [
    { offset: 0, easing: 'ease-in', props: { opacity: '0', transform: 'scale(0.9)' } },
    { offset: 0.3, easing: 'ease-out', props: { opacity: '1', transform: 'scale(1.05)' } },
    { offset: 1, easing: 'ease-in', props: { opacity: '1', transform: 'scale(1)' } },
  ],
  properties: ['opacity', 'transform'],
};

export const waapi: AnimationSpec = {
  ...base,
  id: 'w1',
  kind: 'waapi',
  name: 'slide',
  selector: '.box:nth-of-type(2)',
  duration: 800,
  iterations: 3,
  direction: 'alternate',
  fill: 'forwards',
  easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
  keyframes: [
    { offset: 0, easing: 'linear', props: { transform: 'translateX(0px)' } },
    { offset: 1, easing: 'linear', props: { transform: 'translateX(200px)' } },
  ],
  properties: ['transform'],
};

const spring = springToLinear({ bounce: 0.35, visualDuration: 0.5 });
export const springSpec: AnimationSpec = {
  ...base,
  id: 's1',
  kind: 'waapi',
  name: 'spring',
  selector: '.dot',
  duration: spring.duration,
  easing: spring.easing,
  keyframes: [
    { offset: 0, easing: 'linear', props: { transform: 'translateY(40px)' } },
    { offset: 1, easing: 'linear', props: { transform: 'none' } },
  ],
  properties: ['transform'],
};

export const steps: AnimationSpec = {
  ...waapi,
  id: 'st',
  name: 'sprite',
  iterations: 1,
  direction: 'normal',
  easing: 'steps(6, jump-start)',
  keyframes: [
    { offset: 0, easing: 'linear', props: { backgroundPositionX: '0px' } },
    { offset: 1, easing: 'linear', props: { backgroundPositionX: '-600px' } },
  ],
  properties: ['backgroundPositionX'],
};

export const gsapSpec: AnimationSpec = {
  ...base,
  id: 'g1',
  kind: 'gsap',
  name: 'tween',
  selector: '.logo',
  duration: 1000,
  delay: 500,
  iterations: 'infinite',
  easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  keyframes: [{ offset: 1, easing: 'linear', props: { transform: 'translateX(100px) rotate(90deg)' } }],
  properties: ['transform'],
  gsap: {
    easeName: 'back.out(1.7)',
    easeSamples: [],
    yoyo: true,
    repeatDelay: 0.2,
    vars: { x: '100', rotation: '90' },
  },
};
