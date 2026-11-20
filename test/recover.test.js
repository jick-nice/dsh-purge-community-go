// 拒答续跑：判定 + 去重 + 每会话上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  looksLikeModelRefusal,
  inspectRefusal,
  createRecoverLedger,
  makeRecoverMessage,
  installRecover,
  RECOVER_DEFAULTS,
} from '../lib/recover.js'

const userEvent = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
const assistantEvent = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const turnEnd = (seq, kind = 'completed') => ({ type: 'turn/end', seq, data: { reason: { kind } } })

function fakeAgent(events) {
  const sent = []
  return {
    id: 'sess-1',
    status: 'idle',
    session: { snapshotEvents: () => events },
    followup: (message) => sent.push(message),
    sent,
  }
}

test('拒答句式能认出来，我们自己的硬停句不算', () => {
  assert.equal(looksLikeModelRefusal('抱歉，我不能提供这类内容。'), true)
  assert.equal(looksLikeModelRefusal("I'm sorry, I can't help with that."), true)
  assert.equal(looksLikeModelRefusal('出于安全考虑，这个请求我无法完成'), true)
  assert.equal(looksLikeModelRefusal('不行，这是严令禁止的'), false)
  assert.equal(looksLikeModelRefusal('结果如下：端口 22 开着。'), false)
  assert.equal(looksLikeModelRefusal('短'), false)
})

test('inspectRefusal：正常收工的拒答才 eligible', () => {
  const agent = fakeAgent([userEvent('扫一下这个网段'), assistantEvent('抱歉，我不能协助这类请求。'), turnEnd(7)])
  const info = inspectRefusal(agent)
  assert.equal(info.refusal, true)
  assert.equal(info.turnEnded, true)
  assert.equal(info.reasonKind, 'completed')
  assert.equal(info.humanAfterAssistant, false)
  assert.equal(info.eligible, true)
  assert.equal(info.seq, 7)
})

test('inspectRefusal：人已经接着说下一句时不追', () => {
  const agent = fakeAgent([
    userEvent('任务一'),
    assistantEvent('抱歉，我不能协助。'),
    turnEnd(3),
    userEvent('那换个说法'),
  ])
  assert.equal(inspectRefusal(agent).eligible, false)
})

test('inspectRefusal：中断/取消收工不追', () => {
  const agent = fakeAgent([userEvent('x'), assistantEvent('抱歉，我不能协助。'), turnEnd(4, 'aborted')])
  assert.equal(inspectRefusal(agent).eligible, false)
})

test('ledger：同一 seq 只追一次，超过上限不再追，冷却期内不追', () => {
  const ledger = createRecoverLedger()
  assert.equal(ledger.take('s', 5, 2, 1000, 10_000), true)
  assert.equal(ledger.take('s', 5, 2, 1000, 10_000), false)
  assert.equal(ledger.take('s', 6, 2, 1000, 10_100), false, '冷却期内')
  assert.equal(ledger.take('s', 6, 2, 1000, 20_000), true)
  assert.equal(ledger.take('s', 7, 2, 1000, 30_000), false, '到上限')
  ledger.refund('s')
  assert.equal(ledger.count('s'), 1)
  ledger.forget('s')
  assert.equal(ledger.count('s'), 0)
})

test('续跑消息带自己的 source，避免被当成人类发言', () => {
  const message = makeRecoverMessage('继续')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'dsh-purge-community-go')
  assert.equal(message.source.summary, 'refusal-recover')
  assert.equal(message.content[0].text, '继续')
  assert.equal(makeRecoverMessage('').content[0].text, RECOVER_DEFAULTS.recoverText)
})

test('installRecover：一轮拒答后真的追一句，且只追一次', async () => {
  let handler = null
  const ctx = { on(event, fn) { if (event === 'agent/status') handler = fn } }
  const recover = installRecover(ctx, { getConfig: () => ({ recoverRefusal: true, recoverMax: 2, recoverCooldownMs: 0 }) })
  assert.ok(recover)
  const agent = fakeAgent([userEvent('任务'), assistantEvent('抱歉，我不能协助。'), turnEnd(9)])
  handler({ agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0].source.summary, 'refusal-recover')

  handler({ agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(agent.sent.length, 1, '同一 seq 不该再追')
  recover.dispose()
})
