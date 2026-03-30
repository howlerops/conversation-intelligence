import { defineConfig } from 'vitepress';

const repositoryName = (process.env.GITHUB_REPOSITORY || 'howlerops/conversation-intelligence').split('/')[1];
const base = process.env.GITHUB_ACTIONS === 'true' ? '/' + repositoryName + '/' : '/';

export default defineConfig({
  title: 'Conversation Intelligence',
  description: 'Speaker-aware conversation intelligence runtime, validation stack, and self-hosting docs.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [new RegExp('^https://github\\.com/')],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Validation', link: '/testing-and-validation' },
      { text: 'Self-Hosting', link: '/self-hosting' },
      { text: 'API', link: '/api-and-runtime' },
      { text: 'GitHub', link: 'https://github.com/howlerops/conversation-intelligence' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Runtime Modes', link: '/runtime-modes' },
          { text: 'Self-Hosting', link: '/self-hosting' },
          { text: 'Operations', link: '/operations' },
        ],
      },
      {
        text: 'Validation',
        items: [
          { text: 'Testing and Validation', link: '/testing-and-validation' },
          { text: 'Benchmark Data', link: '/benchmark-data' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API and Runtime', link: '/api-and-runtime' },
          { text: 'CLI Reference', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/configuration' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/howlerops/conversation-intelligence' },
    ],
    search: {
      provider: 'local',
    },
    footer: {
      message: 'Production-first conversation intelligence runtime and validation stack.',
      copyright: 'Copyright 2026 HowlerOps',
    },
  },
});
