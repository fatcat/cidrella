// ESLint flat config — correctness-focused, not stylistic. Formatting churn is
// deliberately avoided on this established codebase; stylistic enforcement is
// the format-on-edit hook's job in projects that opt into Prettier (this one
// doesn't — see CLAUDE.md "Conventions").
import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '.claude/**',
      'client/dist/**',
      'dist/**',
      'server/data/**',
      'screenshots/**',
      'scripts/test-harness/results/**',
    ],
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  // Server + scripts: Node ESM
  {
    files: ['server/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // CommonJS dev scripts (root scripts/ uses require())
  {
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
  // Client: browser
  {
    files: ['client/src/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  // Tests: vitest globals are imported explicitly, but allow node env
  {
    files: ['**/tests/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Build configs run under Node even when they live in the client package
  {
    files: ['**/vite.config.js', '**/vitest.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Rule calibration: recommended is the floor; relax the rules that fight
  // legitimate existing patterns rather than indicating bugs.
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control chars in regexes are deliberate here (DNS wire format, log parsing)
      'no-control-regex': 'off',
      // Sound practice but 7 pre-existing violations in error-wrapping code;
      // revisit as a cleanup pass, not a lint gate.
      'preserve-caught-error': 'off',
      // View components are legitimately single-word (Settings.vue, GeoIP.vue)
      'vue/multi-word-component-names': 'off',
      // Vue stylistic rules off — formatting is not lint's job here, and the
      // codebase predates the linter. Correctness rules from the plugin stay on.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/mustache-interpolation-spacing': 'off',
      'vue/attribute-hyphenation': 'off',
      'vue/v-on-event-hyphenation': 'off',
    },
  },
];
