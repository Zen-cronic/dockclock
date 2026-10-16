import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/cdk.out/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
);
