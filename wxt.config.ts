import { defineConfig } from 'wxt';

export default defineConfig({
  // `dist/` instead of `.output/` so the folder shows up in the macOS
  // Load-unpacked picker (dot-folders are hidden there).
  outDir: 'dist',
  manifest: {
    name: 'Motion Inspector',
    short_name: 'Motion Inspector',
    description: 'Pause, scrub and export the animations on any page as CSS, linear(), Motion or GSAP.',
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open Motion Inspector',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '128': 'icon/128.png',
      },
    },
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '128': 'icon/128.png',
    },
  },
});
