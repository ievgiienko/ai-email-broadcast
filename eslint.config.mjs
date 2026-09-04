import next from "eslint-config-next";

/**
 * eslint-config-next v16 exports a ready-made flat config array.
 */
export default [
  {
    ignores: [".next/**", "node_modules/**", "drizzle/**", "dist-scripts/**", "next-env.d.ts", "*.config.*"],
  },
  ...next,
  {
    // Scoped to TypeScript: the typescript-eslint plugin is only loaded there.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
