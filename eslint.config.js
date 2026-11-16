import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['letterboxd-friend-recs.user.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
];
