module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: [
    'react',
    'react-hooks',
    '@typescript-eslint',
    'jsx-a11y',
  ],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    // Native inputs and FocusScope manage focus through their own component contracts.
    'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // Explicit CommonJS loaders, Expo plugins and generated codecs use require.
      files: [
        '**/*.cjs',
        'packages/app/plugins/*.js',
        'packages/backend/src/**/hyperschema/index.js',
      ],
      parserOptions: { sourceType: 'script' },
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      files: ['packages/backend/src/**/*.{js,mjs}'],
      rules: {
        'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
      },
    },
    {
      files: [
        'packages/app/**/*.{js,jsx,ts,tsx}',
        'packages/spec/**/*.{js,jsx,ts,tsx}',
        'scripts/**/*.js',
      ],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            {
              group: [
                'corestore',
                'hyperbee',
                'hypercore',
                'hyperblobs',
                'hypercore-blob-server',
                'hyperswarm',
                'protomux',
                'protomux-wakeup',
                'hypercore-crypto',
                'b4a',
                'bare-*',
              ],
              message: 'Import Holepunch primitives from backend runtime modules instead of directly.',
            },
          ],
        }],
      },
    },
    {
      // Every screen and player surface the app ships. Without this the size
      // limit stopped at the backend and the largest files in the repo were
      // the ones nothing measured.
      files: ['packages/app/app/**/*.{js,jsx,ts,tsx}', 'packages/app/components/**/*.{js,jsx,ts,tsx}'],
      rules: {
        'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
  settings: {
    react: {
      version: 'detect',
    },
  },
  ignorePatterns: [
    'build/',
    'desktop-build/',
    'node_modules/',
    '*.config.js',
    // Vendored Bare addons. Upstream source, not ours to restyle.
    'packages/bare-*/',
  ],
};
