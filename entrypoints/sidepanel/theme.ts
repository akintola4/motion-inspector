import { icons } from './icons';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'mi-theme';
const ORDER: ThemePref[] = ['system', 'light', 'dark'];

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setupTheme(button: HTMLButtonElement) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let pref = read();
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'light' || forced === 'dark') pref = forced;

  const apply = () => {
    const resolved = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
    document.body.dataset.theme = resolved;
    button.innerHTML = pref === 'system' ? icons.system : pref === 'light' ? icons.sun : icons.moon;
    const label = `Theme: ${pref}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  };

  button.addEventListener('click', () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* private mode */
    }
    apply();
  });
  media.addEventListener('change', apply);
  apply();
}
