/**
 * 平台保存/提交适配器协议（F10，ADR-0018/0020）
 *
 * v1 分层（Q18b/D14）：
 * - 章节测验：页面侧全量适配（start/save/submit/readResult/abort），server 只下发指令并等待回执；
 * - 作业/随堂/考试：仅能力探测（auto_save=false / auto_submit=false），不新造保存路径。
 * 页面侧能力由 frame 桥实现（entry-mcp 的 mcp/traversal.ts），本文件是 server 侧的协议封装。
 */

import { BrowserHost } from './browser.js';
import { EventRouter } from './inject.js';
import { McpToolError, RunManager } from './run-manager.js';
import { ManagedRun, isTerminalRun } from './types.js';

export type SubmitOutcome =
	| { kind: 'ok'; run: ManagedRun; evidence: string }
	| { kind: 'failed'; run: ManagedRun; evidence: string }
	| { kind: 'uncertain'; run: ManagedRun; evidence: string }
	| { kind: 'unsupported'; message: string };

export class Adapters {
	constructor(private browser: BrowserHost, private rm: RunManager, private router: EventRouter) {}

	/**
	 * submit_paper 执行入口：前置状态校验由 RunManager.submitPaper 完成（可能抛 McpUnsupportedError）。
	 * 本方法下发提交指令并按回执驱动状态机；结果不确定时先 readResult 核验，禁止盲目重复提交。
	 */
	async executeSubmit(runId: string, mode: 'temporary' | 'confirm'): Promise<SubmitOutcome> {
		let run = this.rm.getRun(runId);
		if (!run) throw new McpToolError(`run ${runId} 不存在。`);
		// 能力是动态页面事实：提交前实时复查一次（页面侧注册可能晚于 start_work）
		try {
			const page = this.browser.getPage(run.pageKey);
			if (page) {
				const live = await this.router.queryFrameCapabilities(page);
				if (live && JSON.stringify(live) !== JSON.stringify(run.capabilities)) {
					run = this.rm.updateCapabilities(runId, live);
				}
			}
		} catch {
			/* 探测失败按已知能力处理 */
		}
		await this.rm.submitPaper(runId, mode);

		const knownSuccess = (): SubmitOutcome | undefined => {
			const current = this.rm.getRun(runId)!;
			if (
				current.status === 'finished' ||
				current.status === 'saved-and-left' ||
				(mode === 'temporary' && current.status === 'saved')
			) {
				return { kind: 'ok', run: current, evidence: current.submitEvidence ?? '当前权威状态已确认成功' };
			}
		};
		let result;
		try {
			result = await this.router.sendSubmit(runId, mode);
		} catch (error) {
			result = { ok: false, timedOut: true, evidence: String(error) };
		}
		const success = knownSuccess();
		if (success) return success;
		if (result.timedOut) {
			// 已终止的 run 不再访问旧 frame；核验期间仍可能收到成功回执。
			const current = this.rm.getRun(runId)!;
			const probe = isTerminalRun(current.status) ? null : await this.router.readResult(runId).catch(() => null);
			const confirmed = knownSuccess();
			if (confirmed) return confirmed;
			if (probe && (probe.submitted === true || (probe.saved === true && mode === 'temporary'))) {
				this.rm.applySubmitResult(runId, mode, true, 'readResult 核验确认');
				const verified = knownSuccess();
				if (verified) return verified;
			}
			const marked = this.rm.markSubmitUncertain(runId, `提交无回执且核验未确认（${result.evidence}）`);
			return { kind: 'uncertain', run: marked, evidence: result.evidence };
		}

		return { kind: 'failed', run: this.rm.getRun(runId) ?? run, evidence: result.evidence };
	}

	/** abort_run：向页面传播取消 signal（终止所有等待与 DOM 写入） */
	async executeAbort(runId: string, reason?: string): Promise<ManagedRun> {
		const run = this.rm.abortRun(runId, reason);
		await this.router.pushCancel(runId, reason ?? 'aborted');
		return run;
	}
}
