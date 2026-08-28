import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores(['main.js', 'test/**', 'scripts/**', 'esbuild.config.mjs']),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
      },
    },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['Streamient'] }],
    },
  },
]);
