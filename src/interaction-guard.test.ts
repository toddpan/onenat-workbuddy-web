/**
 * 值守模式（interactionGuard + engine 值守判定）回归测试。
 *
 * 背景：曾出现子智能体在聊天直发路径拿到 attended 守卫（允许 ask_user_question），
 * 导致远程 DSH 会话停下来等提问且提问卡无法透传回 WorkBuddy UI，整条任务链挂死。
 * 修复后的合同：只有「节点主会话且非定时任务」允许提问，其余一律 unattended。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interactionGuard } from './prompt-composer.js'

const NODE_AGENT_ID = '__node__'

/** 复刻 engine.runChatTurn 的值守判定（保持同步，改动 engine 时须同步更新本测试） */
function selectInteraction(agentId: string, scheduleId?: string): 'attended' | 'unattended' {
  return agentId === NODE_AGENT_ID && !scheduleId ? 'attended' : 'unattended'
}

test('节点主会话（用户直发、非定时）为有人值守，允许 ask_user_question', () => {
  const guard = interactionGuard(selectInteraction(NODE_AGENT_ID))
  assert.equal(selectInteraction(NODE_AGENT_ID), 'attended')
  assert.match(guard, /可调用 ask_user_question/)
})

test('成员/子智能体一律无人值守，严格禁止 ask_user_question', () => {
  for (const agentId of ['agt-test', 'agt-lead', 'agt-x']) {
    assert.equal(selectInteraction(agentId), 'unattended')
    assert.doesNotMatch(interactionGuard('unattended'), /可调用 ask_user_question/)
  }
})

test('定时任务即使走节点主会话也是无人值守', () => {
  assert.equal(selectInteraction(NODE_AGENT_ID, 'sch-1'), 'unattended')
})

test('unattended 守卫说明停等后果（远程 DSH 阻塞），降低模型违反概率', () => {
  const guard = interactionGuard('unattended')
  assert.match(guard, /禁止调用 ask_user_question/)
  assert.match(guard, /阻塞整条任务链|停下来/)
})
