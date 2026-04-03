import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import * as ProduckEslint from '@produck/eslint-rules';

export default [
	{
		files: ['**/*.{js,mjs,cjs,ts}'],
	},
	{
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	ProduckEslint.config,
	ProduckEslint.excludeGitIgnore(import.meta.url),
];
