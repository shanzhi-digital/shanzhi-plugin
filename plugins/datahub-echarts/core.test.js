import test from 'node:test';
import assert from 'node:assert/strict';
import {canPresentResults,extractSqlResult,buildChart,finiteNumber,currentTurnText,cleanFollowUps} from './core.js';
import {apply} from './index.js';
const user = (text) => ({type:'user/message',data:{content:[{type:'text',text}]}});
const args={datasourceId:'3000017',sql:'SELECT activity_type FROM domain_b960408b',title:'活动',dimension:'activity_type',measures:['n'],chartType:'bar'};
const result={queryKind:'SEMANTIC_SQL',datasourceId:args.datasourceId,semanticSql:args.sql,columns:[{name:'activity_type',type:'String'},{name:'n',type:'Int64'}],data:[{activity_type:'志愿服务',n:'3'}],rowCount:1,truncated:false,offset:0,limit:100};
test('普通问数允许展示，保留当前回合与仅文字约束',()=>{
 for(const question of ['本月学生志愿情况','按区县统计报名人数','不要图表，给表格','不要图表给表格','请用饼图展示占比']) {
  assert.equal(canPresentResults([{type:'turn/start'},user(question)]),true,question);
 }
 for(const question of ['只用文字回答','仅文本说明','不用表格和图表']) {
  assert.equal(canPresentResults([{type:'turn/start'},user(question)]),false,question);
 }
 assert.equal(canPresentResults([user('统计报名人数')]),false);
 assert.equal(canPresentResults([{type:'turn/start'},user('统计报名人数'),{type:'turn/end'}]),false);
 assert.equal(canPresentResults([{type:'turn/start'},user('只用文字回答'),user('改为表格展示')]),true);
});
test('普通问数默认表格，明确绘图才显示图形，仍保留切换列',()=>{
 const bare={datasourceId:args.datasourceId,sql:args.sql,title:'结果'};
 for(const question of ['按类别统计人数','各类别占比','每月趋势','问表：活动情况']) {
  const value=buildChart(bare,result,question);
  assert.equal(value.defaultView,'table',question);
  assert.equal(value.dimension,'activity_type');
  assert.deepEqual(value.measures,['n']);
 }
 for(const [question,view] of [['用柱状图展示人数','bar'],['画一下每月报名人数趋势','line'],['用饼图展示占比','pie']]) {
  assert.equal(buildChart(bare,result,question).defaultView,view,question);
 }
 assert.equal(buildChart({...bare,chartType:'line'},result).defaultView,'line');
 assert.equal(buildChart({...bare,chartType:'pie'},result,'不要图表，直接给表格').defaultView,'table');
 assert.equal(buildChart({...bare,chartType:'bar'},result,'用表格展示人数').defaultView,'table');
});
test('成功结果与数据源和 SQL 精确匹配',()=>{
 assert.deepEqual(buildChart(args,extractSqlResult({isError:false,value:result})).data,result.data);
 assert.throws(()=>extractSqlResult({isError:true}));
 assert.throws(()=>buildChart(args,{...result,datasourceId:'other'}));
 assert.throws(()=>buildChart(args,{...result,semanticSql:'other'}));
 assert.deepEqual(buildChart({...args,measures:['不存在']},result).data,result.data);
 assert.deepEqual(buildChart({...args,measures:['不存在']},result).measures,['n']);
 assert.deepEqual(extractSqlResult({isError:false,content:[{type:'text',text:JSON.stringify(result)}]}),result);
});
test('无图表时保留真实结果并给出原因',()=>{
 const bare={datasourceId:args.datasourceId,sql:args.sql,title:'结果'};
 const textResult={...result,columns:[{name:'name',type:'String'}],data:[{name:'志愿服务'}]};
 const text=buildChart(bare,textResult);assert.deepEqual(text.data,textResult.data);assert.deepEqual(text.measures,[]);assert.ok(text.reason);
 const scalarResult={...result,columns:[{name:'n',type:'Int64'}],data:[{n:'3'}]};
 const scalar=buildChart(bare,scalarResult);assert.deepEqual(scalar.data,scalarResult.data);assert.equal(scalar.dimension,null);
 const empty=buildChart(bare,{...result,data:[],rowCount:0});assert.deepEqual(empty.data,[]);assert.match(empty.reason,/没有返回/);
 assert.equal(finiteNumber('   '),null);assert.equal(finiteNumber('9007199254740992'),null);assert.equal(finiteNumber('3'),3);
});
test('安全数值边界不会吞掉十进制或科学计数的小数部分',()=>{
 for(const value of ['9007199254740991.1','-9007199254740991.1','9007199254740990.9','9.0071992547409911e15']) assert.equal(finiteNumber(value),null,value);
 for(const value of ['9007199254740991','9007199254740991.0','9.007199254740991e15','90071992547409910e-1']) assert.equal(finiteNumber(value),Number.MAX_SAFE_INTEGER,value);
});
test('省略或给错绘图列时按真实结果自动识别',()=>{
 const bare={datasourceId:args.datasourceId,sql:args.sql,title:'结果'};
 const real={...result,columns:[{name:'activity_type',type:'String',title:'活动类别'},{name:'enroll',type:'Int64',title:'已报名人数'},{name:'checkin',type:'Int64',title:'签到人数'},{name:'id',type:'Int64',title:'活动编号'}],data:[{activity_type:'志愿服务',enroll:'691',checkin:'644',id:'3'},{activity_type:'文体活动',enroll:'1006',checkin:'960',id:'4'}]};
 const auto=buildChart(bare,real);
 assert.equal(auto.dimension,'activity_type');
 assert.deepEqual(auto.measures,['enroll']);
 assert.equal(auto.chartType,'bar');
 const explicit=buildChart({...bare,measures:['enroll','checkin']},real);
 assert.deepEqual(explicit.measures,['enroll','checkin']);
 const wrong=buildChart({...bare,dimension:'不存在',measures:['id']},real);
 assert.equal(wrong.dimension,'activity_type');
 assert.ok(!wrong.measures.includes('id'));
 const pie=buildChart({...bare,chartType:'pie'},real);
 assert.equal(pie.chartType,'pie');
 assert.deepEqual(pie.measures,['enroll']);
 assert.equal(buildChart({...bare,chartType:'pie'},real).measures.length,1);
});
test('按用户原话选指标与图型',()=>{
 const bare={datasourceId:args.datasourceId,sql:args.sql,title:'结果'};
 const cols=[{name:'activity_type',type:'String',title:'活动类别'},{name:'activity_count',type:'Int64',title:'活动ID数量'},{name:'enroll_total',type:'Int64',title:'已报名人数合计'},{name:'checkin_total',type:'Int64',title:'签到人数合计'},{name:'hours',type:'Double',title:'志愿时长'}];
 const real={...result,columns:cols,data:[{activity_type:'志愿服务',activity_count:'3',enroll_total:'691',checkin_total:'644',hours:'1973'},{activity_type:'文体活动',activity_count:'4',enroll_total:'1006',checkin_total:'960',hours:'0'}]};
 const plain=buildChart(bare,real,'问表：本月学生的志愿情况');
 assert.deepEqual(plain.measures,['activity_count']);

 const enroll=buildChart(bare,real,'问表：按活动类型统计报名人数');
 assert.deepEqual(enroll.measures,['enroll_total']);

 const both=buildChart(bare,real,'问表：按活动类型对比签到人数和报名人数');
 assert.deepEqual(both.measures,['checkin_total','enroll_total']);

 const share=buildChart(bare,real,'问表：各活动类型报名人数的占比');
 assert.equal(share.chartType,'pie');
 assert.deepEqual(share.measures,['enroll_total']);

 const trend=buildChart(bare,real,'问表：报名人数按月趋势');
 assert.equal(trend.chartType,'line');

 const explicit=buildChart({...bare,chartType:'bar'},real,'问表：占比构成');
 assert.equal(explicit.chartType,'bar');
 assert.equal(currentTurnText([{type:'turn/start'},user('问表：报名人数')]),'问表：报名人数');
 assert.equal(currentTurnText([{type:'turn/start'},user('问表'),{type:'turn/end'}]),'');
});
test('跟问建议最多三条且去重清洗',()=>{
 const bare={datasourceId:args.datasourceId,sql:args.sql,title:'结果'};
 const charts=buildChart({...bare,followUps:['  各单位的报名人数排名？ ','各单位的报名人数排名？','这些单位里签到率最低的是哪个？','  ','换一个维度']},result);
 assert.equal(charts.followUps.length,3);
 assert.deepEqual(charts.followUps,['各单位的报名人数排名？','这些单位里签到率最低的是哪个？','换一个维度']);
 assert.deepEqual(buildChart(bare,result).followUps,[]);
 assert.deepEqual(cleanFollowUps(['短','这是一个足够长的跟问问题吗？','x'.repeat(200)]),['这是一个足够长的跟问问题吗？']);
});
test('模拟查询管线绑定当前会话结果',async()=>{
 let tool,query; const agent={id:'a'}; const signal=new AbortController().signal; const token=Symbol('parent');
 const ctx={systemPrompt:{section(){}},sessions:{get(id){assert.equal(id,'a');return {snapshotEvents(){return [{type:'turn/start'},user('按类别统计本月学生志愿情况')]}}}},tools:{register(t){tool=t},get(name,scope){assert.equal(scope,agent);return {}},async execute(input){query=input;return {isError:false,value:result}}}};
 apply(ctx);
 for(const followUps of [undefined,null,[],['可以展开查看这些活动吗？'],Array(3).fill('可以展开查看这些活动吗？'),['短','  ','另一条完整的问题可以吗？'],'可以展开查看这些活动吗？']) {
  await assert.rejects(tool.execute({...args,followUps},{agent,signal,token,rootCallId:'root'}),/3 条/);
  assert.equal(query,undefined);
 }
 const plain=await tool.execute({datasourceId:args.datasourceId,sql:args.sql,title:'活动类别统计'},{agent,signal,token,rootCallId:'root'});
 assert.equal(plain.defaultView,'table');assert.deepEqual(plain.data,result.data);assert.deepEqual(plain.followUps,[]);
 const value=await tool.execute({...args,followUps:['  可以展开查看这些活动吗？ ','可以按月展示报名人数吗？','可以换成志愿时长指标吗？']},{agent,signal,token,rootCallId:'root'});
 assert.deepEqual(value.followUps,['可以展开查看这些活动吗？','可以按月展示报名人数吗？','可以换成志愿时长指标吗？']);
 assert.equal(query.name,'mcp__datahub-ask-data__execute_semantic_sql');assert.equal(query.agent,agent);assert.equal(query.signal,signal);assert.equal(query.parent,token);assert.equal(query.arguments.sql,args.sql);assert.deepEqual(value.data,result.data);
});
