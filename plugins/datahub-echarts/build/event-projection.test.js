import test from 'node:test';
import assert from 'node:assert/strict';
import { definition } from './event-projection.js';
const value = { title: '结果', columns: [{ name: 'a' }], data: [{ a: 1 }], measures: [] };
const start = { type: 'turn/start', data: { turn: 3 } };
const call = (name = 'query_result_chart') => ({ type: 'tool/call', data: { turn: 3, callId: 'c1', name } });
const result = () => ({ type: 'tool/result', seq: 8, surfaceOp: 'append', data: { turn: 3, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
function reduce(events) {
  return events.reduce((state, event) => definition.update({ state }, { event }), definition.start(null, { event: start }));
}

test('both new and compatibility tool cards replay once', () => {
  for (const name of ['query_result_chart', 'datahub_chart']) {
    const state = reduce([call(name), result(), result()]);
    assert.equal(state.charts.length, 1);
    assert.deepEqual(state.charts[0].value, value);
    const location = definition.buildLocationData({ state }, 'turn');
    assert.equal(definition.buildLocationData({ state }, 'turn', location), location);
    assert.equal(definition.buildLocationData({ state }, 'session'), null);
    assert.deepEqual(reduce([call(name), result()]).charts, state.charts);
  }
});

test('later surface replacement removes an obsolete card or its query source', () => {
  const direct = { type: 'system/message', seq: 9, surfaceOp: { op: 'replace', startSeq: 8, endSeq: 8 }, data: { turn: 3 } };
  assert.equal(reduce([call(), result(), direct]).charts.length, 0);
  const sourced = result();
  sourced.data.message.content[0].text = JSON.stringify({ ...value, source: { resultSeq: 4 } });
  const sourceReplacement = { ...direct, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } };
  assert.equal(reduce([call(), sourced, sourceReplacement]).charts.length, 0);
});

test('a source replaced before its chart finishes cannot reappear in a late result', () => {
  const replacement = { type: 'system/message', seq: 7,
    surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, data: { turn: 3 } };
  const sourced = result();
  sourced.data.message.content[0].text = JSON.stringify({ ...value, source: { resultSeq: 4 } });
  assert.equal(reduce([call(), replacement, sourced]).charts.length, 0);

  const untouched = result();
  untouched.data.message.content[0].text = JSON.stringify({ ...value, source: { resultSeq: 5 } });
  assert.equal(reduce([call(), replacement, untouched]).charts.length, 1);
});

test('unrelated, failed, replaced and malformed results do not render cards', () => {
  assert.equal(reduce([call('other_tool'), result()]).charts.length, 0);
  assert.equal(reduce([result()]).charts.length, 0);
  const failed = result(); failed.data.message.isError = true;
  const replaced = result(); replaced.surfaceOp = 'replace';
  const malformed = result(); malformed.data.message.content[0].text = 'not json';
  const other = result(); other.data.message.source.callId = 'other';
  assert.equal(reduce([call(), failed, replaced, malformed, other]).charts.length, 0);
});
