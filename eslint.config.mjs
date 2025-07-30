import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
    files: ["**/*.ts"],
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2020,
        sourceType: "module",
    },
    rules: {
        "@typescript-eslint/naming-convention": [
            "warn",
            {
                selector: "variable",
                format: ["camelCase", "PascalCase"],
                filter: {
                    regex: "^_$",
                    match: false
                }
            },
            {
                selector: "function",
                format: ["camelCase"],
            },
            {
                selector: "typeLike",
                format: ["PascalCase"],
            },
        ],
        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];