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
      files: ['packages/backend/src/{runtime,swarm,feed,media,hash-utils}.js'],
      rules: {
        'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
  settings: {
    react: {
      version: 'detect',
    },
  },
  ignorePatterns: ['build/', 'node_modules/', '*.config.js'],
};
