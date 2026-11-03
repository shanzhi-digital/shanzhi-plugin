import * as echarts from 'echarts';
import React from 'react';
import { finiteNumber } from '../core.js';
const h=React.createElement;
const KEY='datahub-echarts';
const VERSION=typeof __PLUGIN_VERSION__==='string'?__PLUGIN_VERSION__:'dev';
const VIEWS=[['bar','柱状图'],['line','折线图'],['pie','饼图'],['table','表格']];
const definition={
  kind:KEY,
  match(event){if(event.type==='turn/start')return {id:String(event.data.turn),role:'start'};if(event.type==='tool/call'||event.type==='tool/result')return {id:String(event.data.turn),role:'update'};return null;},
  start(_context,match){return {turn:match.event.data.turn,calls:new Set(),charts:[]};},
  update(context,match){const e=match.event,s=context.state;if(e.type==='tool/call'){if(e.data.name!=='datahub_chart')return s;const calls=new Set(s.calls);calls.add(String(e.data.callId));return {...s,calls};}
    if(e.type!=='tool/result'||e.surfaceOp!=='append'||e.data.message?.isError||e.data.error||!s.calls.has(String(e.data.message?.source?.callId)))return s;
    const texts=(e.data.message?.content||[]).filter(x=>x.type==='text');if(texts.length!==1)return s;let value;try{value=JSON.parse(texts[0].text);}catch{return s;}
    if(!value||!Array.isArray(value.data)||!Array.isArray(value.columns)||!Array.isArray(value.measures))return s;
    return {...s,charts:[...s.charts,{seq:e.seq,value}]};},
  buildLocationData(context,scope,previous){const s=context.state;if(scope!=='turn'||!s)return null;if(previous?.kind==='turn'&&previous.value===s.charts)return previous;return {kind:'turn',turn:s.turn,key:KEY,value:s.charts};}
};
const MUTED='var(--dsw-alias-label-secondary)';
const BORDER='var(--dsw-alias-border-l1)';

function Plot({value,type}){
 const ref=React.useRef(null);const rows=value.data;const measures=value.measures;const valid=rows.length>0&&measures.some(name=>rows.some(row=>finiteNumber(row[name])!==null));
 React.useEffect(()=>{if(!valid||!ref.current)return;const node=ref.current;const chart=echarts.init(node,null,{renderer:'canvas'});const style=getComputedStyle(node);const color=style.getPropertyValue('--dsw-alias-label-secondary').trim()||'#667085';
 const palette=['#4f78d3','#12a893','#e19d38','#9d65bd','#df7070','#4bb3d4','#8d6bd1'];
 const labels=rows.map(r=>String(r[value.dimension]??'（空）'));
 if(type==='pie'){const measure=measures[0];chart.setOption({color:palette,tooltip:{trigger:'item',renderMode:'richText'},legend:{textStyle:{color},bottom:0,type:'scroll'},series:[{name:value.columns.find(c=>c.name===measure)?.title||measure,type:'pie',radius:['38%','68%'],center:['50%','46%'],avoidLabelOverlap:true,label:{color,formatter:'{b} {d}%'},data:rows.map((row,i)=>({name:labels[i],value:finiteNumber(row[measure])}))}]});}
 else{chart.setOption({color:palette,tooltip:{trigger:'axis',renderMode:'richText'},legend:{textStyle:{color}},grid:{left:55,right:24,top:45,bottom:80,containLabel:true},xAxis:{type:'category',data:labels,axisLabel:{color,rotate:rows.length>8?35:0}},yAxis:{type:'value',axisLabel:{color}},series:measures.map(name=>({name:value.columns.find(c=>c.name===name)?.title||name,type:type==='line'?'line':'bar',data:rows.map(row=>finiteNumber(row[name]))}))});}
 const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>chart.resize()):null;observer?.observe(node);return()=>{observer?.disconnect();chart.dispose();};},[value,type,valid]);
 if(!valid)return h('p',{style:{color:MUTED,margin:'8px 0'}},value.reason||(rows.length?'结果没有可绘制的有效数值或超出安全精度，已保留原始表格。':'查询没有返回数据。'));
 return h('div',{ref,role:'img','aria-label':value.title||'数据图表',style:{width:'100%',height:300}});
}
function ResultTable({value}){
 const columns=value.columns;
 return h('div',{style:{overflowX:'auto',border:`1px solid ${BORDER}`,borderRadius:8}},
  h('table',{style:{borderCollapse:'collapse',width:'100%',fontSize:12}},h('thead',null,h('tr',null,...columns.map(c=>h('th',{key:c.name,style:{padding:'6px 8px',textAlign:'left',whiteSpace:'nowrap',borderBottom:`1px solid ${BORDER}`}},c.title||c.name)))),
  h('tbody',null,...value.data.map((row,i)=>h('tr',{key:i},...columns.map(c=>h('td',{key:c.name,style:{padding:'6px 8px',whiteSpace:'nowrap',borderBottom:`1px solid ${BORDER}`}},row[c.name]==null?'—':String(row[c.name]))))))));
}
function Segmented({view,onChange}){
 return h('div',{role:'group','aria-label':'呈现方式',style:{display:'inline-flex',flexShrink:0,border:`1px solid ${BORDER}`,borderRadius:8,overflow:'hidden'}},
  ...VIEWS.map(([id,label])=>{const active=view===id;return h('button',{key:id,type:'button','aria-pressed':active,title:label,onClick:()=>onChange(id),
   style:{border:0,borderLeft:id===VIEWS[0][0]?0:`1px solid ${BORDER}`,background:active?'var(--dsw-alias-bg-layer-2)':'transparent',color:active?'var(--dsw-alias-label-primary)':MUTED,cursor:'pointer',font:'inherit',fontSize:12,lineHeight:'24px',padding:'0 10px'}},label);}));
}
function Chart({value,inputActions}){
 const [view,setView]=React.useState(value.measures.length>0?(value.chartType||'bar'):'table');
 const hasNumeric=value.measures.some(name=>value.data.some(row=>finiteNumber(row[name])!==null));
 const hasUnplottable=value.measures.some(name=>value.data.some(row=>row[name]!=null&&String(row[name]).trim()!==''&&finiteNumber(row[name])===null));
 const showChart=view!=='table'&&hasNumeric&&Boolean(value.dimension);
 return h('section',{style:{border:`1px solid ${BORDER}`,background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',borderRadius:10,padding:16,margin:'12px 0',overflow:'hidden'}},
  h('div',{style:{display:'flex',alignItems:'flex-start',gap:12,flexWrap:'wrap',justifyContent:'space-between'}},
   h('div',{style:{minWidth:0,flex:'1 1 200px'}},
    h('strong',null,value.title||'数据图表'),
    h('div',{style:{fontSize:12,color:MUTED,marginTop:4}},`数据源：${value.datasourceId} · 返回 ${value.data.length} 行${value.truncated?' · 结果已截断，可继续分页':''}${hasUnplottable?' · 部分数值无法安全绘制，原值见表格':''}`)),
   h(Segmented,{view,onChange:setView})),
  h('div',{style:{marginTop:12}},showChart?h(Plot,{value,type:view}):h(ResultTable,{value})),
  view==='table'&&value.data.length===0?h('p',{style:{color:MUTED,fontSize:12}},value.reason||'查询没有返回数据。'):null,
  h(FollowUps,{items:value.followUps,inputActions}),
  h('div',{style:{marginTop:8,fontSize:11,color:MUTED,textAlign:'right'}},`问表图表插件 v${VERSION}`));
}
function FollowUps({items,inputActions}){
 const [note,setNote]=React.useState('');
 React.useEffect(()=>{if(!note)return;const timer=setTimeout(()=>setNote(''),2400);return()=>clearTimeout(timer);},[note]);
 if(!Array.isArray(items)||items.length===0)return null;
 const pick=(text)=>{
  try{const span=inputActions&&inputActions.captureInsertion?inputActions.captureInsertion():undefined;
   if(span&&typeof inputActions.insertText==='function'){inputActions.insertText(text,span);setNote('已填入输入框，按 Enter 发送');return;}}
  catch{/* fall through to the clipboard */ }
  try{navigator.clipboard.writeText(text);setNote('已复制，粘贴即可追问');}catch{setNote('请手动输入该问题');}
 };
 return h('div',{style:{marginTop:12,paddingTop:12,borderTop:`1px solid ${BORDER}`}},
  h('div',{style:{fontSize:12,color:MUTED,marginBottom:8}},note||'可以接着问：'),
  h('div',{style:{display:'flex',flexWrap:'wrap',gap:8}},
   ...items.map((text,index)=>h('button',{key:index,type:'button',title:text,onClick:()=>pick(text),
    style:{border:`1px solid ${BORDER}`,borderRadius:999,background:'transparent',color:'var(--dsw-alias-label-primary)',cursor:'pointer',font:'inherit',fontSize:12,lineHeight:'20px',padding:'4px 12px',textAlign:'left',maxWidth:'100%'}},text))));
}
function TurnTail(props){const charts=props.turn.data.get(KEY)||[];return h(React.Fragment,null,...charts.filter(item=>item.seq<props.seq).map(item=>h(Chart,{key:item.seq,value:item.value,inputActions:props.inputActions})));}
export const inject=['slots','uiConversation'];
export function apply(ctx){ctx.uiConversation.events.register(definition);ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:KEY,order:10},TurnTail));}
