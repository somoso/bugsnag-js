const ruleOverrides = {
  // TODO CHECK THESE
  'jest/no-test-callback': 'off',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/no-unused-vars': 'off',
  '@typescript-eslint/camelcase': 'off',
  
  '@typescript-eslint/no-explicit-any': 'off',
        
  // This incorrectly fails on TypeScript method override signatures
  'no-dupe-class-members': 'off',

  // Disable all rules that require parserServices (for now)
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  '@typescript-eslint/no-unnecessary-type-assertion': 'off',
  '@typescript-eslint/prefer-nullish-coalescing': 'off',
  '@typescript-eslint/prefer-readonly': 'off',
  '@typescript-eslint/promise-function-async': 'off',
  '@typescript-eslint/require-array-sort-compare': 'off',
  '@typescript-eslint/require-await': 'off',
  '@typescript-eslint/restrict-plus-operands': 'off',
  '@typescript-eslint/restrict-template-expressions': 'off',
  '@typescript-eslint/strict-boolean-expressions': 'off',
}

module.exports = {
  plugins: [
    'react'
  ],
  rules: {
    'react/jsx-uses-react': 'error',
    'react/jsx-uses-vars': 'error'
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    jsx: true,
    ecmaVersion: 2018
  },
  overrides: [
    // linting for js files
    {
      files: ['**/*.js'],
      extends: [
        'standard'
      ]
    },
    // linting for ts files
    {
      files: ['**/*.ts'],
      extends: 'standard-with-typescript',
      // We can't use rules which requires parserServices as there is no tsconfig that represents the whole monorepo (yet).
      // 'parserOptions': {
      //     'project': './tsconfig.json'
      // },
      rules: {
        ...ruleOverrides
      }
    },
    // Linting for tests
    {
      files: [
        'packages/core/**/*.test.[tj]s?(x)'
      ],
      env: {
        jest: true,
        browser: true,
      },
      plugins: ['eslint-plugin-jest'],
      extends: [
        'standard-with-typescript',
        'plugin:jest/recommended'
      ],
      rules: {
        ...ruleOverrides
      }
    }
  ]
}
