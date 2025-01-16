import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from 'eslint-plugin-import';

export default [
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    ignores: [
      "**/dist/",
      "**/test/",
      "**/cache/",
      "**/bundle/",
      "**/examples/",
      "**/src/proto/generated/",
      "**/*.{js,mjs,cjs}",
      "**/*.d.ts",
      "*.ts",
    ],
  }, {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      }
    },
    rules: {
      "max-len": ["error", {
        code: 200,
        ignoreComments: true,
        ignoreTrailingComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }], quotes: ["error", "single"],
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "import/no-unresolved": "off",
      "import/no-duplicates": "error",
      'no-sparse-arrays': 'off',
      "no-template-curly-in-string": "error",
      "no-unreachable-loop": "error",
      "no-unused-private-class-members": "off",
      "no-prototype-builtins": "off",
      "no-async-promise-executor": "off",
      "no-case-declarations": "off",
      "no-return-assign": "off",
      "no-floating-decimal": "error",
      "no-implied-eval": "error",
      "arrow-spacing": "error",
      "no-invalid-this": "error",
      "no-lone-blocks": "off",
      "no-new-func": "off",
      "no-new-wrappers": "error",
      "no-new": "error",
      "no-void": "error",
      "no-octal-escape": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-throw-literal": "error",
      "no-unmodified-loop-condition": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-escape": "error",
      "no-useless-return": "error",
      "no-else-return": "error",
      "no-lonely-if": "error",
      "no-undef-init": "error",
      "no-unneeded-ternary": "error",
      "no-var": "error",
      "no-multi-spaces": "error",
      "no-multiple-empty-lines": ["error", {
        max: 1,
        maxEOF: 0,
      }],
      "no-tabs": "error",
      "brace-style": "error",
      "new-parens": "error",
      "space-infix-ops": "error",
      "template-curly-spacing": "error",
      "wrap-regex": "error",
      "prefer-template": "error",
      "keyword-spacing": ["error", {
        before: true,
      }],
      "object-curly-spacing": ["warn", "always"],
      "array-bracket-spacing": ["error", "always"],
      "arrow-parens": ["error", "always"],
      "comma-dangle": ["error", "never"],
      "comma-spacing": ["error", {
        before: false,
        after: true,
      }],
      "computed-property-spacing": ["error", "never"],
      "func-call-spacing": ["error", "never"],
      indent: ["error", 2, {
        SwitchCase: 1,
      }],
      "key-spacing": ["error", {
        beforeColon: false,
      }],
      semi: ["error", "always"],
      "operator-assignment": ["error", "always"],
    },
  }
];