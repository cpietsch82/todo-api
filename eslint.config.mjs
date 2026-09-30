// eslint.config.mjs
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Ignorierte Verzeichnisse (ersetzt .eslintignore)
  {
    ignores: ['dist/', 'node_modules/', '**/*.d.ts'],
  },

  // Basis-Regeln für alle Dateien
  js.configs.recommended,

  // ✅ Root-Config-Dateien: kein project-basiertes Parsen
  {
    files: ['*.config.ts', '*.config.js'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.node },
      // kein parserOptions.project hier
    },
  },
  // TypeScript-Quelldateien mit vollem Typecheck
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.node,  // process, require, __dirname etc.
      },
      parserOptions: {
        project: './tsconfig.json', // aktiviert typbasierte Regeln
      },
    },
    rules: {
      // Anpassen nach Bedarf:
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',

      // no-namespace: Namespaces verbieten, aber declare-Blöcke erlauben
      '@typescript-eslint/no-namespace': ['error', {
        allowDeclarations: true,   // erlaubt: declare namespace Foo { ... }
        allowDefinitionFiles: true, // erlaubt Namespaces in .d.ts-Dateien
      }],
    },
  },
);