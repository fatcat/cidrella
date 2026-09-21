// ESLint flat config: correctness-focused, not stylistic. Formatting is
// Prettier's job (.prettierrc.json, adopted 2026-09-12) and lint deliberately
// does not duplicate it, so the two can never disagree. See CLAUDE.md
// "Conventions" for the scope and the blame-ignore setup.
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
      'tmp/**',
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

  // Reuse guards. These turn the "shared things exist, use them" convention in
  // CLAUDE.md into rules: a vendor component reaches the app only through
  // src/ui, a form control is one of the wrappers, and a status mark is one
  // of the status components. Each rule that has pre-existing violations
  // carries a BASELINE of files it does not run against yet. Fixing a file
  // means deleting it from the baseline; adding a file to silence a new
  // finding defeats the guard. scripts/check-scoped-css-dupes.js and
  // scripts/check-confirm-dialogs.js cover what ESLint cannot see.
  {
    files: ['client/src/**/*.{js,vue}'],
    ignores: ['client/src/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['openvue', 'openvue/*', 'primevue', 'primevue/*'],
              message:
                'Import the wrapper from client/src/ui/<Component>.js, never the vendor package. One module per component; add one there if it is missing.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['client/src/**/*.vue'],
    ignores: [
      'client/src/ui/**',
      // BASELINE, raw form controls. Each of these predates the rule. Remove a
      // file here once its <select>/<input> use the src/ui wrappers, or once
      // the raw control is judged deliberate (search boxes inside a custom bar
      // are; a checkbox in a form that uses ToggleSwitch elsewhere is not).
      'client/src/components/DebugPanel.vue',
      'client/src/components/DhcpPanel.vue',
      'client/src/components/DnsPanel.vue',
      'client/src/components/first-run/StepImport.vue',
      'client/src/components/InterfacePanel.vue',
      'client/src/components/PiholeImportPanel.vue',
      'client/src/components/ScopeDialog.vue',
      'client/src/components/settings/SettingsArea.vue',
      'client/src/views/Blocklists.vue',
      'client/src/views/DHCP.vue',
      'client/src/views/GeoIP.vue',
      'client/src/views/networks-workspace/AddressDetailsPanel.vue',
      'client/src/views/networks-workspace/dialogs/AddressScanDialog.vue',
      'client/src/views/networks-workspace/dialogs/IpReservationEditor.vue',
      'client/src/views/networks-workspace/dialogs/RangeTypeDialog.vue',
      'client/src/views/networks-workspace/ResourceExplorer.vue',
      'client/src/views/networks-workspace/WorkspaceTable.vue',
      'client/src/views/networks-workspace/WorkspaceToolbar.vue',
      'client/src/views/settings/BackupSettings.vue',
      'client/src/views/settings/NetworkSettings.vue',
      'client/src/views/settings-workspace/SettingsWorkspace.vue',
      'client/src/views/SubnetsLayoutB.vue',
    ],
    rules: {
      'vue/no-restricted-html-elements': [
        'error',
        {
          element: 'select',
          message: 'Use the Select wrapper from client/src/ui/Select.js.',
        },
        {
          element: 'input',
          message:
            'Use InputText, InputNumber, Checkbox, ToggleSwitch or Password from client/src/ui. For a type the wrappers do not cover (file, color, range) add an eslint-disable-next-line comment saying so.',
        },
      ],
    },
  },
  {
    files: ['client/src/**/*.vue'],
    ignores: [
      'client/src/components/StatusDot.vue',
      'client/src/components/StatusBadge.vue',
      'client/src/components/table/AddressTypePill.vue',
      // BASELINE, hand-drawn status marks. Remove a file once it renders its
      // dot or badge through StatusDot / StatusBadge / AddressTypePill. What
      // is left is badges and pills (the classic views keep theirs until
      // they are removed).
      'client/src/components/FolderNetworkTable.vue',
      'client/src/views/Blocklists.vue',
      'client/src/views/GeoIP.vue',
      'client/src/views/SubnetsLayoutB.vue',
      'client/src/views/ThemeLab.vue',
      'client/src/views/settings/BlocklistSearch.vue',
      'client/src/views/settings/LogsSettings.vue',
      'client/src/views/settings/TwoFactorSettings.vue',
    ],
    rules: {
      'vue/no-restricted-class': [
        'error',
        'dot',
        'status-dot',
        'pill',
        'badge',
        'status-badge',
        'indicator',
      ],
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
      // Vue stylistic rules off, formatting is not lint's job here, and the
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
