import * as echarts from 'echarts';
import React from 'react';
import { finiteNumber, cleanFollowUps } from '../core.js';
import { createExport } from './export.js';
const h=React.createElement;
import { KEY, definition } from './event-projection.js';
const VIEWS=[['table','表格'],['bar','柱状图'],['line','折线图'],['pie','饼图']];
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
 const cellStyle=column=>({padding:'12px 10px',textAlign:/(?:number|int|decimal|float|double|numeric|real)/i.test(column.type||'')?'right':'left',whiteSpace:'nowrap',borderBottom:`1px solid ${BORDER}`,fontVariantNumeric:'tabular-nums'});
 return h('div',{style:{overflowX:'auto'}},
  h('table',{style:{borderCollapse:'collapse',width:'100%',fontSize:13,lineHeight:'20px'}},
   h('thead',null,h('tr',null,...columns.map(c=>h('th',{key:c.name,scope:'col',style:{...cellStyle(c),fontWeight:600}},c.title||c.name)))),
   h('tbody',null,...value.data.map((row,i)=>h('tr',{key:i},...columns.map(c=>h('td',{key:c.name,style:cellStyle(c)},row[c.name]==null?'—':String(row[c.name]))))))));
}
const controlStyle={border:`1px solid ${BORDER}`,borderRadius:6,background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',font:'inherit',fontSize:12,lineHeight:'20px',padding:'5px 10px',cursor:'pointer'};
function ViewSelect({view,onChange}){
 return h('select',{'aria-label':'呈现方式',value:view,onChange:event=>onChange(event.target.value),style:controlStyle},
  ...VIEWS.map(([id,label])=>h('option',{key:id,value:id},label)));
}
function ExportMenu({value}){
 const root=React.useRef(null);const [open,setOpen]=React.useState(false);const [error,setError]=React.useState('');
 React.useEffect(()=>{
  if(!open)return;
  root.current?.querySelector('[role="menuitem"]')?.focus();
  const outside=event=>{if(!root.current?.contains(event.target))setOpen(false);};
  const escape=event=>{if(event.key==='Escape'){setOpen(false);root.current?.querySelector('button')?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[open]);
 const download=format=>{
  let url;let anchor;
  try{
   const file=createExport(value,format);
   url=URL.createObjectURL(new Blob([file.data],{type:file.mime}));
   anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename;document.body.appendChild(anchor);anchor.click();
   setError('');
  }catch{setError('导出失败，请重试。');}
  finally{anchor?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);setOpen(false);}
 };
 return h('div',{ref:root,style:{position:'relative'}},
  h('button',{type:'button','aria-label':'导出','aria-haspopup':'menu','aria-expanded':open,onClick:()=>setOpen(!open),style:controlStyle},'导出 ▾'),
  open?h('div',{role:'menu','aria-label':'导出格式',style:{position:'absolute',right:0,top:'calc(100% + 5px)',zIndex:20,minWidth:120,padding:4,border:`1px solid ${BORDER}`,borderRadius:7,background:'var(--dsw-alias-bg-layer-1)',boxShadow:'0 4px 14px rgba(0,0,0,.08)'}},
   ...['csv','xlsx'].map(format=>h('button',{key:format,role:'menuitem',type:'button',onClick:()=>download(format),style:{...controlStyle,display:'block',border:0,width:'100%',textAlign:'left',whiteSpace:'nowrap'}},`导出 ${format.toUpperCase()}`))):null,
  error?h('span',{role:'alert',style:{position:'absolute',right:0,top:'100%',whiteSpace:'nowrap',fontSize:12,color:MUTED}},error):null);
}
function Chart({value,view,onViewChange}){
 const hasNumeric=value.measures.some(name=>value.data.some(row=>finiteNumber(row[name])!==null));
 const hasUnplottable=value.measures.some(name=>value.data.some(row=>row[name]!=null&&String(row[name]).trim()!==''&&finiteNumber(row[name])===null));
 const invalidPie=view==='pie'&&(value.data.some(row=>(finiteNumber(row[value.measures[0]])??0)<0)||!value.data.some(row=>(finiteNumber(row[value.measures[0]])??0)>0));
 const showChart=view!=='table'&&hasNumeric&&Boolean(value.dimension)&&!invalidPie;
 const totalNote=value.rowCount>value.data.length?` / 共 ${value.rowCount} 行`:'';
 return h(React.Fragment,null,
  h('div',{style:{display:'flex',alignItems:'flex-start',gap:12,flexWrap:'wrap',justifyContent:'space-between'}},
   h('strong',{style:{minWidth:0,flex:'1 1 200px',fontSize:14,lineHeight:'22px'}},value.title||'查询结果'),
   h('div',{style:{display:'flex',alignItems:'center',gap:8,flexShrink:0}},h(ExportMenu,{key:value.title,value}),h(ViewSelect,{view,onChange:onViewChange}))),
  h('div',{style:{marginTop:12}},showChart?h(Plot,{value,type:view}):h(ResultTable,{value})),
  !showChart&&(value.reason||invalidPie)?h('p',{style:{color:MUTED,fontSize:12}},value.reason||(invalidPie?'结果含负数或全部为零，无法呈现有效占比，已保留原始表格。':'')):null,
  h('div',{style:{fontSize:12,color:MUTED,marginTop:12}},`${value.data.length} 行 · ${value.columns.length} 列${totalNote}${value.offset>0?` · 偏移 ${value.offset}`:''}${value.truncated?' · 仅展示部分结果，可继续分页':''}${hasUnplottable?' · 部分数值无法安全绘制，原值见表格':''}`));
}
function ResultsPanel({charts,inputActions}){
 const panelId=React.useId();
 const [selected,setSelected]=React.useState(charts[0]?.seq);
 const [views,setViews]=React.useState({});
 const active=charts.find(item=>item.seq===selected)||charts[0];
 React.useEffect(()=>{if(active&&selected!==active.seq)setSelected(active.seq);},[active?.seq,selected]);
 if(!active)return null;
 const value=active.value;
 const view=views[active.seq]||value.defaultView||(value.measures.length>0?(value.chartType||'bar'):'table');
 const followUps=charts.map(item=>cleanFollowUps(item.value.followUps)).findLast(items=>items.length===3)||[];
 const changeTab=(index,focus=false)=>{
  setSelected(charts[index].seq);
  if(focus)document.getElementById(`${panelId}-tab-${charts[index].seq}`)?.focus();
 };
 return h('div',{style:{margin:'16px 0',color:'var(--dsw-alias-label-primary)'}},
  h('section',{'aria-label':'查询结果',style:{border:`1px solid ${BORDER}`,background:'var(--dsw-alias-bg-layer-1)',borderRadius:10,padding:16,minWidth:0}},
   charts.length>1?h(React.Fragment,null,
    h('div',{style:{color:MUTED,fontSize:12,marginBottom:8}},`查询结果 · ${charts.length} 份`),
    h('div',{role:'tablist','aria-label':'查询结果列表',style:{display:'flex',gap:16,overflowX:'auto',borderBottom:`1px solid ${BORDER}`,marginBottom:16}},
     ...charts.map((item,index)=>h('button',{key:item.seq,id:`${panelId}-tab-${item.seq}`,role:'tab',type:'button','aria-selected':item.seq===active.seq,'aria-controls':`${panelId}-panel-${active.seq}`,tabIndex:item.seq===active.seq?0:-1,title:item.value.title||`结果 ${index+1}`,
      onClick:()=>changeTab(index),onKeyDown:event=>{
       let next;if(event.key==='ArrowRight')next=(index+1)%charts.length;else if(event.key==='ArrowLeft')next=(index+charts.length-1)%charts.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=charts.length-1;
       if(next!==undefined){event.preventDefault();changeTab(next,true);}
      },style:{border:0,borderBottom:item.seq===active.seq?'2px solid var(--dsw-alias-label-primary)':'2px solid transparent',padding:'8px 0',background:'transparent',color:item.seq===active.seq?'var(--dsw-alias-label-primary)':MUTED,font:'inherit',fontSize:13,fontWeight:item.seq===active.seq?600:400,cursor:'pointer',whiteSpace:'nowrap',maxWidth:200,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis'}},item.value.title||`结果 ${index+1}`)))):null,
   h('div',{role:charts.length>1?'tabpanel':undefined,id:`${panelId}-panel-${active.seq}`,'aria-labelledby':charts.length>1?`${panelId}-tab-${active.seq}`:undefined},
    h(Chart,{key:active.seq,value,view,onViewChange:next=>setViews(previous=>({...previous,[active.seq]:next}))}))),
  h(FollowUps,{items:followUps,inputActions}));
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
 return h('div',{'aria-label':'后续问题',style:{marginTop:16,padding:'0 2px'}},
  h('div',{style:{fontSize:12,color:MUTED,marginBottom:8}},note||'进一步分析'),
  h('div',{style:{display:'flex',flexWrap:'wrap',gap:8}},
   ...items.map((text,index)=>h('button',{key:index,type:'button',title:text,onClick:()=>pick(text),
    style:{border:`1px solid ${BORDER}`,borderRadius:999,background:'transparent',color:'var(--dsw-alias-label-primary)',cursor:'pointer',font:'inherit',fontSize:12,lineHeight:'20px',padding:'4px 12px',textAlign:'left',maxWidth:'100%'}},text))));
}
function TurnTail(props){const charts=(props.turn.data.get(KEY)||[]).filter(item=>item.seq<props.seq);return h(ResultsPanel,{charts,inputActions:props.inputActions});}
export const inject=['slots','uiConversation'];
export function apply(ctx){ctx.uiConversation.events.register(definition);ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:KEY,order:10},TurnTail));}
