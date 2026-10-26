/**
 * stderr 日志：MCP stdio 模式下 stdout 是协议通道，业务日志一律走 stderr。
 */

function ts(): string {
	return new Date().toISOString();
}

function write(level: string, args: unknown[]) {
	const parts = args.map((a) => {
		if (a instanceof Error) return a.stack || a.message;
		if (typeof a === 'object' && a !== null) {
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		}
		return String(a);
	});
	process.stderr.write(`[${ts()}] [${level}] ${parts.join(' ')}\n`);
}

export const log = {
	debug: (...args: unknown[]) => {
		if (process.env.MCP_XXT_DEBUG) write('DEBUG', args);
	},
	info: (...args: unknown[]) => write('INFO', args),
	warn: (...args: unknown[]) => write('WARN', args),
	error: (...args: unknown[]) => write('ERROR', args)
};
