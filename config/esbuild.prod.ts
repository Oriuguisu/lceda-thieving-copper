import process from 'node:process';
import esbuild from 'esbuild';

import { allBuildOptions } from './esbuild.common.ts';

(async () => {
	const contexts = await Promise.all(allBuildOptions.map(options => esbuild.context(options)));
	if (process.argv.includes('--watch')) {
		await Promise.all(contexts.map(context => context.watch()));
	}
	else {
		await Promise.all(contexts.map(context => context.rebuild()));
		process.exit();
	}
})();
