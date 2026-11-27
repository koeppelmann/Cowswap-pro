(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let data, selectedTwap=null, selectedUid=null, bookView=null, bookResetPending=false, bookFrame=0, activeBookUid=null, latestRows=[], chartEventsBound=false, yClamp=false,userViewport=null,applyingSnapshot=false,lastSnapshotId=null,polling=false;
  const axisLabel = (value, base) => {if(value===0)return base?'0':'$0';const label=value>=1000?compact(value):String(Number(value.toPrecision(6)));return (base?'':'$')+label;};
  function volumeTicks(rawMax,compressed,unit,base){rawMax=Math.max(rawMax,unit);const values=[0];if(compressed){const start=Math.ceil(Math.log10(unit));for(let p=start;p<=Math.ceil(Math.log10(rawMax));p++){const v=10**p;if(v<=rawMax*1.08)values.push(v);}}else{const scale=10**Math.floor(Math.log10(rawMax/5));const ratio=rawMax/5/scale;const step=(ratio<=1?1:ratio<=2?2:ratio<=5?5:10)*scale;for(let v=step;v<=rawMax*1.08;v+=step)values.push(v);}return {tickvals:values.map(v=>compressed?Math.log10(1+v/unit):v),ticktext:values.map(v=>axisLabel(v,base))};}
  function visibleDepthMax(traces,range,unit){let max=unit;const lo=range?Math.min(...range):-Infinity,hi=range?Math.max(...range):Infinity;for(const t of traces)for(let i=0;i<t.x.length;i++){const x=Number(t.x[i]);if(x>=lo&&x<=hi)max=Math.max(max,Number(t.customdata[i][7]));if(i>0){const prev=Number(t.x[i-1]);if(Math.min(x,prev)<=hi&&Math.max(x,prev)>=lo)max=Math.max(max,Number(t.customdata[i][7]),Number(t.customdata[i-1][7]));}}return max;}
  const short = s => s ? s.slice(0,6)+'…'+s.slice(-4) : '—';
  const compact = value => Number(value).toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2});
  const money = value => {const n=Number(value),a=Math.abs(n);if(a>0&&a<0.000001)return '$'+n.toPrecision(4);const digits=a>0&&a<10?Math.min(12,Math.max(5,Math.ceil(-Math.log10(a))+3)):2;return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:digits});};
  const fmt = (v, digits=4) => { const n=Number(v); return n && (Math.abs(n)<10**-digits || Math.abs(n)>1e12) ? n.toExponential(4) : n.toLocaleString(undefined,{maximumFractionDigits:digits}); };
  function cells(parent, values, title='') { const tr=document.createElement('tr'); tr.title=title; for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);} parent.append(tr);return tr; }
  function pair() { return data.pairs.find(p=>p.id===$('pair').value)||data.pairs[0]; }
  function symbol() { return pair().base_symbol; }
  function baseSymbol(row) { return data.metadata[row.base_token]?.symbol||symbol(); }
  function current() { return $('market').value==='all'?pair().modes.enriched:pair().quote_modes[$('market').value]; }
  function pairLabel(p){const n=(p.twap_schedules||[]).filter(r=>Number(r.remaining_parts)>0).length;return p.label+(n?' · '+n+' TWAP'+(n===1?'':'s'):'');}
  function updateURL(){const url=new URL(location.href);url.search='';url.searchParams.set('token',pair().id);if($('market').value!=='all')url.searchParams.set('quote',data.metadata[$('market').value].symbol);history.replaceState(null,'',url);}
  function selectPair(){userViewport=null;const p=pair();renderConversions();$('window').value='quotes';$('depth').querySelector('[value=base]').textContent=p.base_symbol;$('reference').textContent=p.reference_available===false?'—':money(p.reference_usdc_equivalent);$('reference').title=p.reference_available===false?'Reference unavailable in latest auction':p.reference_usdc_equivalent+' USDC-equivalent per '+p.base_symbol;resetSelection();markets();if(p.default_quote&&[...$('market').options].some(o=>o.value===p.default_quote))$('market').value=p.default_quote;render();updateURL();}
  function renderConversions(){const entries=pair().conversions||[];$('conversionPanel').hidden=!entries.length;$('conversions').replaceChildren();for(const c of entries){const tr=cells($('conversions'),[c.symbol,fmt(c.eth_per_token,10),c.source?'Reference ⓘ':'—']);tr.title=c.source||'';tr.children[2].title=c.source||'';}}
  function resetSelection(){selectedTwap=null;$('takeOrder').hidden=false;$('detailTitle').textContent='Selected order';DfusionTakeUI.clearOrder();bookView=null;selectedUid=null;$('orderDetail').hidden=true;$('orderSearch').value='';}
  function markets() {
    $('market').replaceChildren();const option=document.createElement('option');option.value='all';option.textContent='All major stables';$('market').append(option);
    for(const address of Object.keys(pair().quote_modes).sort((a,b)=>data.metadata[a].symbol.localeCompare(data.metadata[b].symbol))){const o=document.createElement('option');o.value=address;o.textContent=data.metadata[address].symbol;$('market').append(o);}
  }
  function ammMarker(){
    const marker=pair().amm_marker;if(!marker||marker.status!=='available')return null;
    const mid=Number(marker.mid_usdc_equivalent),bid=Number(marker.bid_usdc_equivalent),ask=Number(marker.ask_usdc_equivalent);
    return [mid,bid,ask].every(v=>Number.isFinite(v)&&v>0)&&bid<=mid&&mid<=ask?{...marker,mid,bid,ask}:null;
  }
  function ammDescription(marker){
    const asset=data.metadata[marker.base_token]?.symbol||symbol(),quote=marker.quote_symbol||data.metadata[marker.quote_token]?.symbol||'quote';
    const fee=marker.fee_bps==null?NaN:Number(marker.fee_bps),curve=marker.pool_kind==='curve',feeLabel=Number.isFinite(fee)?(curve?'Base fee ':'')+fmt(fee,3)+' bp'+(curve?'':' fee'):'Directional fees';
    return {pair:asset+' / '+quote,feeLabel,curve};
  }
  function renderAmm(){
    const marker=ammMarker(),enabled=$('amm').checked,description=marker?ammDescription(marker):null;
    $('ammPool').hidden=!marker;$('ammPrices').hidden=!marker;$('amm').closest('.amm-strip').classList.toggle('is-disabled',!enabled);
    const fallback=Boolean(marker?.higher_ranked_discovered_pool);
    $('ammStatus').textContent=marker?description.feeLabel+' · '+(fallback?'supported fallback':'activity-ranked'):pair().amm_marker?.reason||'Pool marker unavailable';
    $('ammStatus').title=marker?(description.curve?'Curve bid/ask sample approximately $1 in each direction, including pool fees and finite-size impact; mid is geometric. Gas is excluded. ':'Pool spot price with fee-adjusted marginal bid/ask. Gas and trade-size price impact are excluded. ')+'Quote tokens are normalized with CoW reference values. Transfer taxes are excluded. '+(marker.selection_caveat||'Most active verified supported pool by surveyed 24h volume')+'. '+(marker.activity_observed_at?'Volume survey as of '+marker.activity_observed_at+'. ':'')+'Coverage may be incomplete.':'No verified on-chain pool marker is available for this snapshot.';
    if(marker){
      $('ammPool').textContent=marker.venue+' · '+description.pair;
      if(/^0x[0-9a-f]{40}$/i.test(marker.pool))$('ammPool').href='https://etherscan.io/address/'+marker.pool;else $('ammPool').removeAttribute('href');
      $('ammPool').title=marker.pool+' · block '+Number(marker.block).toLocaleString();
      $('ammBid').textContent=money(marker.bid);$('ammMid').textContent=money(marker.mid);$('ammAsk').textContent=money(marker.ask);
      $('ammPrices').title='USDC-equivalent per '+symbol()+'. Bid: output when selling the asset. Ask: cost when buying it. '+(description.curve?'Approximately $1 quotes include pool fees and finite-size impact; geometric mid; no gas.':'Marginal pool fee included; gas and size impact excluded.');
    }
    return enabled?marker:null;
  }
  function twapRows(){
    const selected=$('market').value,stable=pair().modes.enriched.quote_usdc_equivalent_rates||{};
    return (pair().twap_schedules||[]).filter(r=>{
      const price=Number(r.normalized_price),amount=Number(r.remaining_usdc_equivalent);
      const quoteMatches=selected==='all'?(r.quote_is_stable??Object.hasOwn(stable,r.quote_token)):r.quote_token===selected;
      return quoteMatches&&r.state_complete!==false&&Number(r.remaining_parts)>0&&Number.isFinite(price)&&price>0&&Number.isFinite(amount)&&amount>0;
    });
  }
  function twapVolumes(row,base){
    return base?{total:Number(row.remaining_base_atoms)/10**pair().base_decimals,slice:Number(row.slice_base_atoms)/10**pair().base_decimals}:{total:Number(row.remaining_usdc_equivalent),slice:Number(row.slice_usdc_equivalent)};
  }
  function twapFunding(row){return row.funding_status==='balance_covers_next_slice'?'Balance covers one swap':row.funding_status==='requires_funding'?'Requires funding / conditional':'Funding unverified';}
  function renderTwaps(){
    const rows=twapRows(),all=(pair().twap_schedules||[]).filter(r=>Number(r.remaining_parts)>0);
    $('twapCount').textContent=rows.length;$('twapCount').title=rows.length+' schedules in selected quote view; '+all.length+' for this asset';
    $('twapSelect').replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='Schedules…';$('twapSelect').append(empty);
    for(const row of rows){const option=document.createElement('option');option.value=row.id;option.textContent=(row.side==='bid'?'Buy ':'Sell ')+(row.base_symbol||symbol())+' · '+money(row.normalized_price)+' · '+row.remaining_parts+' swaps';$('twapSelect').append(option);}
    $('twapSelect').hidden=!rows.length;if(selectedTwap&&rows.some(r=>r.id===selectedTwap))$('twapSelect').value=selectedTwap;
    const coverage=data.twap_coverage,pending=Number(coverage?.pending_state_parents||0),unpriced=Number(coverage?.unpriced_schedule_count||0);$('twapCoverage').textContent=rows.length?'Scheduled · not funded depth'+(pending?' · '+pending+' index pending':''):coverage?.status==='unavailable'?'TWAP index unavailable':pending?'Index state pending · '+pending:unpriced?unpriced+' schedules lack a reference price':'No schedules in this quote view';
    $('twapCoverage').title=coverage?'Public index candidates: '+(coverage.api_fetched_count??'unavailable')+'; source '+(coverage.api_status||'unavailable')+'. Recent events from block '+Number(coverage.from_block||coverage.block||0).toLocaleString()+' to '+Number(coverage.to_block||coverage.block||0).toLocaleString()+'. Private, unpublished and unsupported handlers are outside this index.':'TWAP indexing begins with publicly dispatched supported schedules; coverage can be incomplete.';
    return $('twaps').checked?rows:[];
  }
  function twapHit(chart,event){
    if(!$('twaps').checked)return null;const layout=chart._fullLayout;if(!layout)return null;
    const rect=chart.getBoundingClientRect(),x=event.clientX-rect.left-layout.xaxis._offset,y=event.clientY-rect.top-layout.yaxis._offset;
    if(x<0||x>layout.xaxis._length||y<0||y>layout.yaxis._length)return null;
    let best=null;
    for(const trace of chart.data||[]){if(!trace.meta?.twap||trace.visible==='legendonly'||trace.visible===false)continue;const distance=Math.abs(layout.xaxis.d2p(trace.x[0])-x),top=layout.yaxis.d2p(trace.y.at(-1)),bottom=layout.yaxis.d2p(0);if(distance<=9&&y>=Math.min(top,bottom)-8&&y<=Math.max(top,bottom)+8&&(!best||distance<best.distance))best={id:trace.meta.scheduleId,distance};}
    return best?twapRows().find(row=>row.id===best.id):null;
  }
  function placeHover(hover,event){hover.hidden=false;hover.style.left=Math.max(8,Math.min(event.clientX+14,window.innerWidth-hover.offsetWidth-8))+'px';hover.style.top=Math.max(8,Math.min(event.clientY+14,window.innerHeight-hover.offsetHeight-8))+'px';}
  function showTwapHover(row,event){
    const base=$('depth').value==='base',v=twapVolumes(row,base),quantity=n=>base?compact(n)+' '+symbol():'$'+compact(n),hover=$('ammHover');hover.classList.add('twap-hover');
    hover.textContent='TWAP '+(row.side==='bid'?'buy':'sell')+' · '+money(row.normalized_price)+' / '+symbol()+'\nRemaining '+quantity(v.total)+(base?'':' at limit')+' · '+row.remaining_parts+' swaps\nOne swap '+quantity(v.slice)+(base?'':' at limit')+(base?'':'\n'+compact(Number(row.remaining_base_atoms)/10**pair().base_decimals)+' '+symbol()+' remaining · '+compact(Number(row.slice_base_atoms)/10**pair().base_decimals)+' per swap')+'\n'+twapFunding(row)+'\nScheduled, not funded depth · click for details';placeHover(hover,event);
  }
  function showTwap(id){
    const row=twapRows().find(r=>r.id===id);if(!row)return;selectedTwap=id;selectedUid=null;DfusionTakeUI.clearOrder();$('takeOrder').hidden=true;$('detailTitle').textContent='TWAP schedule';$('orderDetail').hidden=false;$('detailContent').replaceChildren();$('twapSelect').value=id;
    const time=n=>{if(!n)return '—';const date=new Date(Number(n)*1000);return Number.isFinite(date.getTime())?date.toISOString().replace('T',' ').slice(0,19)+' UTC':'Beyond supported date range';},amount=(atoms,decimals)=>{const [whole,fraction]=DfusionTake.formatAtoms(atoms||'0',decimals).split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');},base=pair().base_decimals,quote=data.metadata[row.quote_token];
    const fields=[['Side',(row.side==='bid'?'Buy ':'Sell ')+(row.base_symbol||symbol())],['Limit price',money(row.normalized_price)+' / '+symbol()],['Remaining scheduled',amount(row.remaining_base_atoms,base)+' '+symbol()],['One swap',amount(row.slice_base_atoms,base)+' '+symbol()],['Remaining quote at limit',amount(row.remaining_quote_atoms,quote.decimals)+' '+quote.symbol],['Quote per swap at limit',amount(row.slice_quote_atoms,quote.decimals)+' '+quote.symbol],['Remaining value at limit',money(row.remaining_usdc_equivalent)],['One swap value at limit',money(row.slice_usdc_equivalent)],['Remaining eligible swaps',row.remaining_parts+' / '+row.total_parts],['Interval',fmt(Number(row.interval_seconds)/60,2)+' minutes'],['Starts',time(row.start_time)],['Ends',time(row.end_time)],['Next eligible slice',time(row.next_slice_at)],['Funding',twapFunding(row)],['Current slice',row.current_child_invalidated?'Invalidated':row.current_child_filled?'Already executed':row.status?.replaceAll('_',' ')||'Scheduled'],['Scope','Scheduled volume, not funded limit depth']];
    for(const[label,value]of fields){const div=document.createElement('div');div.className='detail-field';const name=document.createElement('span');name.className='detail-label';name.textContent=label;div.append(name,document.createTextNode(String(value)));$('detailContent').append(div);}
    const owner=document.createElement('div');owner.className='detail-field';const label=document.createElement('span');label.className='detail-label';label.textContent='Owner';owner.append(label,document.createTextNode(row.owner));$('detailContent').append(owner);
    const links=document.createElement('div');links.className='detail-links';
    function link(url,text,title){const a=document.createElement('a');a.href=url;a.textContent=text;a.target='_blank';a.rel='noopener noreferrer';if(title)a.title=title;links.append(a);}
    link('https://explorer.cow.fi/address/'+row.owner,'CoW Explorer ↗','Owner history; a TWAP schedule can produce multiple child orders.');
    if(/^0x[0-9a-f]{112}$/i.test(row.current_child_uid||''))link('https://explorer.cow.fi/orders/'+row.current_child_uid,row.current_child_filled&&!row.current_child_invalidated?'Latest filled slice ↗':'Generated slice ↗','This deterministic slice may not yet have been submitted unless a fill is confirmed.');
    if(/^0x[0-9a-f]{64}$/i.test(row.creation_tx||''))link('https://etherscan.io/tx/'+row.creation_tx,'Registration transaction ↗');
    $('detailContent').append(links);const hash=document.createElement('div');hash.className='twap-detail-id';hash.textContent='Schedule '+row.id+' · block '+Number(row.block).toLocaleString();$('detailContent').append(hash);
  }
  function render({preserveViewport=false}={}) {
    const previous=preserveViewport?$('chart').layout:null;
    const viewport=previous?{x:previous.xaxis.range?.slice(),y:previous.yaxis.range?.slice(),tickvals:previous.yaxis.tickvals?.slice(),ticktext:previous.yaxis.ticktext?.slice()}:null;
    const mode=current(),rows=mode.normalized_orders.filter(r=>$('market').value==='all'||r.quote_token===$('market').value),base=$('depth').value==='base',log=$('volumeScale').value==='log',twaps=renderTwaps(),hasReference=pair().reference_available!==false,ref=hasReference?Number(pair().reference_usdc_equivalent):(twaps.length?Number(twaps[0].normalized_price):1);
    document.querySelector('.market-workspace').classList.toggle('twap-only',Boolean(pair().twap_only&&!rows.length));
    const best=side=>rows.filter(r=>r.side===side&&BigInt(r.allocated_base_atoms)>0n&&Number(r.allocated_quote_atoms)/10**data.metadata[r.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[r.quote_token])>=1).sort((a,b)=>(Number(a.normalized_price)-Number(b.normalized_price))*(side==='bid'?-1:1))[0]||null;
    const bidOrder=best('bid'),askOrder=best('ask'),bid=bidOrder?Number(bidOrder.normalized_price):null,ask=askOrder?Number(askOrder.normalized_price):null;
    $('bestBid').textContent=bid==null?'—':money(bid);$('bestAsk').textContent=ask==null?'—':money(ask);
    $('bidQuote').textContent=bidOrder?'paid in '+bidOrder.quote_symbol:'';$('askQuote').textContent=askOrder?'paid in '+askOrder.quote_symbol:'';
    $('bestBid').title=bidOrder?'Best allocated bid, actual payment token '+bidOrder.quote_symbol+'; value normalized by CoW reference price.':'No funded bid worth at least $1';
    $('bestAsk').title=askOrder?'Best allocated ask, actual payment token '+askOrder.quote_symbol+'; value normalized by CoW reference price.':'No funded ask worth at least $1';
    const crossed=bid!=null&&ask!=null&&ask<bid;
    const referenceOverlap=crossed&&(bidOrder.quote_token!==askOrder.quote_token||bidOrder.base_token!==askOrder.base_token);
    $('spreadLabel').textContent=referenceOverlap?'Reference overlap':'Bid–ask spread';
    $('spread').textContent=bid!=null&&ask!=null?fmt(Math.abs((ask-bid)/((ask+bid)/2)*100),2)+'%'+(crossed&&!referenceOverlap?' crossed':''):'—';
    $('spreadPercent').textContent=bid!=null&&ask!=null?fmt(Math.abs((ask-bid)/((ask+bid)/2)*10000),1)+' bps':'';
    $('spread').title=referenceOverlap?'Different settlement tokens, normalized using reference values. This overlap is not proof of an executable match; conversion costs and actual liquidity must be checked.':crossed?'Same-token signed limits cross before fees and execution validation.':'';
    const amm=renderAmm();
    const center=bid!=null&&ask!=null?(bid+ask)/2:bid??ask??ref;
    let bounds=null;if($('window').value==='reference')bounds=[center*.9,center*1.1];if($('window').value==='close')bounds=[center*.95,center*1.05];if($('window').value==='quotes'){const prices=[bid,ask,...(amm?[amm.bid,amm.ask]:[]),...twaps.map(row=>Number(row.normalized_price))].filter(v=>v!=null);if(!prices.length)prices.push(ref);const pad=Math.max(center*.01,(Math.max(...prices)-Math.min(...prices))*.12);bounds=[Math.max(Math.min(...prices)-pad,Number.MIN_VALUE),Math.max(...prices)+pad];}
    if(!hasReference&&!twaps.length&&!amm&&bid==null&&ask==null)bounds=null;
    if(viewport?.x)bounds=$('scale').value==='log'?viewport.x.map(v=>10**v):viewport.x;
    const within=p=>!bounds||(p>=bounds[0]&&p<=bounds[1]),traces=[],logFloor=base?(hasReference?1/ref:1):1;
    const quoteUSD=(r,nominal=false)=>Number(nominal?r.nominal_quote_atoms:r.allocated_quote_atoms)/10**data.metadata[r.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[r.quote_token]);
    for(const nominal of [false,true]){if(nominal&&!$('nominal').checked)continue;for(const side of ['bid','ask']){
      const ordered=rows.filter(r=>r.side===side&&BigInt(nominal?r.nominal_base_atoms:r.allocated_base_atoms)>0n&&($('dust').checked||quoteUSD(r,nominal)>=1)).sort((a,b)=>(Number(a.normalized_price)-Number(b.normalized_price))*(side==='bid'?-1:1)||a.uid.localeCompare(b.uid));
      const x=[],y=[],customdata=[];let quantity=0n,usd=0,orderCount=0;
      const point=(price,depth,cow,uid)=>{if(depth>=0){const order=rows.find(r=>r.uid===uid);const orderUSD=order?Number(nominal?order.nominal_quote_atoms:order.allocated_quote_atoms)/10**data.metadata[order.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[order.quote_token]):0;x.push(price);y.push(log?Math.log10(1+depth/logFloor):depth);customdata.push([cow,uid,money(price),base?compact(depth)+' '+symbol():'$'+compact(depth),'$'+compact(orderUSD),order?short(order.owner):'—',cow==='Before this order'?'Depth before fill':'Total depth',depth,order?baseSymbol(order):symbol(),orderCount,short(uid),order?.quote_symbol||'']);}};
      for(const row of ordered){const price=Number(row.normalized_price),previous=base?Number(quantity)/10**pair().base_decimals:usd;
        point(price,previous,'Before this order',row.uid);
        orderCount++;
        quantity+=BigInt(nominal?row.nominal_base_atoms:row.allocated_base_atoms);
        const quoteAtoms=nominal?row.nominal_quote_atoms:row.allocated_quote_atoms;
        usd+=Number(quoteAtoms)/10**data.metadata[row.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[row.quote_token]);
        point(price,base?Number(quantity)/10**pair().base_decimals:usd,row.quote_symbol+' · '+(baseSymbol(row)),row.uid);
      }
      const levels=new Map();for(let i=0;i<x.length;i++)levels.set(x[i],[customdata[i][3],customdata[i][9]]);
      for(let i=0;i<x.length;i++){const level=levels.get(x[i]);customdata[i][12]=level[0];customdata[i][13]=level[1];customdata[i][14]=level[1]+(level[1]===1?' order':' orders');}
      traces.push({type:'scatter',mode:'lines',x,y,customdata,name:(side==='bid'?'Bids':'Asks')+(nominal?' · nominal':''),line:{color:side==='bid'?'#77c9a6':'#dc9a94',width:nominal?1.2:2.3,dash:nominal?'dot':'solid'},opacity:nominal?.35:1,connectgaps:false,fill:nominal?'none':'tozeroy',fillcolor:side==='bid'?'rgba(119,201,166,0.08)':'rgba(220,154,148,0.07)',meta:{compressed:log,unit:logFloor,base,side,nominal},hovertemplate:'<b>'+(side==='bid'?'Buy':'Sell')+' · %{customdata[2]}</b><br>Total %{customdata[12]} · %{customdata[14]}<br><span style="color:#a0a0ab">%{customdata[10]} · %{customdata[8]}/%{customdata[11]}</span><extra></extra>'});
    }}
    const twapLegend=new Set();
    for(const row of twaps){
      const price=Number(row.normalized_price),v=twapVolumes(row,base);if(!Number.isFinite(v.total)||!Number.isFinite(v.slice)||v.total<=0||v.slice<0)continue;
      const raw=[0,Math.min(v.slice,v.total),v.total],color=row.side==='bid'?'#82bceb':'#b7a0e1',funded=row.funding_status==='balance_covers_next_slice';
      const customdata=raw.map((n,i)=>['TWAP',row.id,money(price),base?compact(n)+' '+symbol():'$'+compact(n),'',short(row.owner),i===1?'One swap':'Remaining scheduled',n,row.base_symbol||symbol(),0,short(row.id),row.quote_symbol||'']);
      traces.push({type:'scatter',mode:'lines+markers',x:[price,price,price],y:raw.map(n=>log?Math.log10(1+n/logFloor):n),customdata,name:'TWAP '+(row.side==='bid'?'buys':'sells'),showlegend:!twapLegend.has(row.side),legendgroup:'twap-'+row.side,line:{color,width:2.2,dash:funded?'solid':'dash'},marker:{color,size:[0,17,8],symbol:['circle','line-ew','diamond'],line:{color,width:2}},opacity:funded?.95:.72,meta:{twap:true,scheduleId:row.id,compressed:log,unit:logFloor,base,side:row.side},hoverinfo:'skip'});twapLegend.add(row.side);
    }
    const initialRawMax=visibleDepthMax(traces,bounds,logFloor);
    const initialUpper=(log?Math.log10(1+initialRawMax/logFloor):initialRawMax)*1.08;
    const ticks=volumeTicks(initialRawMax,log,logFloor,base);
    const mobile=window.innerWidth<600;
    const showReference=pair().reference_available!==false&&(!bounds||(ref>=bounds[0]&&ref<=bounds[1]));
    const shapes=!showReference?[]:[{type:'line',xref:'x',yref:'paper',x0:ref,x1:ref,y0:0,y1:1,line:{color:'#8d9db8',width:1,dash:'dash'}}];
    if(amm){
      shapes.unshift({name:'amm-fee-band',type:'rect',xref:'x',yref:'paper',x0:amm.bid,x1:amm.ask,y0:0,y1:1,fillcolor:'rgba(213,191,138,0.08)',line:{width:0},layer:'below'});
      for(const [name,price,dash,width] of [['amm-bid',amm.bid,'dot',1],['amm-ask',amm.ask,'dot',1],['amm-mid',amm.mid,'solid',1.5]])shapes.push({name,type:'line',xref:'x',yref:'paper',x0:price,x1:price,y0:0,y1:1,line:{color:'#d5bf8a',width,dash}});
    }
    $('ammHover').hidden=true;
    const plotted=Plotly.react('chart',traces,{paper_bgcolor:'#101012',plot_bgcolor:'#101012',font:{color:'#b7b7c1',family:'Inter,Arial,sans-serif',size:11},height:chartHeight(),margin:{l:mobile?55:70,r:22,t:44,b:55},legend:{orientation:'h',x:0,y:1.13,font:{size:11},tracegroupgap:12},dragmode:'zoom',hovermode:'closest',hoverdistance:-1,spikedistance:-1,hoverlabel:{bgcolor:'#1c1d23',bordercolor:'#474853',font:{color:'#eeeef1',size:11,family:'Inter,Arial,sans-serif'},align:'left',namelength:0},modebar:{color:'#797984',activecolor:'#c4d6fa',bgcolor:'#101013'},shapes,
      annotations:!showReference?[]:[{xref:mobile?'paper':'x',yref:'paper',x:mobile?1:($('scale').value==='log'?Math.log10(ref):ref),y:mobile?.98:1.02,text:'Reference '+money(ref),xanchor:'right',yanchor:'bottom',showarrow:false,font:{color:'#aab8d0',size:10},bgcolor:'#101013',borderpad:3}],
      xaxis:{title:{text:'Price · USDC-equivalent / '+symbol(),font:{size:11},standoff:16},type:$('scale').value,showgrid:false,zeroline:false,tickformat:ref<0.001?'.3g':ref<10?',.4f':',.0f',tickprefix:'$',nticks:mobile?3:8,autorange:!bounds,range:bounds?($('scale').value==='log'?bounds.map(Math.log10):bounds):undefined},
      yaxis:{title:{text:base?(twaps.length?'Volume · ':'Depth · ')+symbol():twaps.length?'Volume · USDC-equivalent':'Depth · USDC-equivalent',font:{size:10},standoff:10},type:'linear',tickmode:'array',tickvals:ticks.tickvals,ticktext:ticks.ticktext,autorange:false,range:viewport?.y||[0,initialUpper],...(viewport?{tickvals:viewport.tickvals,ticktext:viewport.ticktext}:{}),minallowed:0,showgrid:false,zeroline:false,rangemode:'tozero'}},{responsive:true,displaylogo:false,scrollZoom:true,displayModeBar:'hover',modeBarButtonsToRemove:['autoScale2d','zoomIn2d','zoomOut2d'],toImageButtonOptions:{format:'svg',filename:'dfusion-pair-limit-depth'}});
    updateVisibleCount(bounds);
    Promise.resolve(plotted).then(()=>{const chart=$('chart');if(chart.on&&!chartEventsBound){bindCompactHover(chart);chart.on('plotly_click',event=>{const point=event.points?.[0];if(point?.data?.meta?.twap){showTwap(point.data.meta.scheduleId);return;}const uid=point?.customdata?.[1];if(uid)showOrder(uid);});chart.on('plotly_relayout',event=>{
      if(yClamp)return;
      const axis=chart._fullLayout?.xaxis||chart.layout?.xaxis;
      let range=event['xaxis.range']||((event['xaxis.range[0]']!=null&&event['xaxis.range[1]']!=null)?[event['xaxis.range[0]'],event['xaxis.range[1]']]:axis?.range);
      if(range&&$('scale').value==='log')range=range.map(v=>10**Number(v));
      updateVisibleCount(range||null);
      const volumeMeta=chart.data?.[0]?.meta||{compressed:false,unit:1,base:false};
      const xChange=Object.keys(event).some(k=>k.startsWith('xaxis.range')||k==='xaxis.autorange');
      const yChange=Object.keys(event).some(k=>k.startsWith('yaxis.range')||k==='yaxis.autorange');
      if(xChange&&!applyingSnapshot)userViewport={range:range.slice(),scale:$('scale').value};
      if(!xChange&&!yChange)return;
      let upper;
      if(xChange){const max=visibleDepthMax(chart.data||[],range,volumeMeta.unit);upper=(volumeMeta.compressed?Math.log10(1+max/volumeMeta.unit):max)*1.08;}
      else {const requested=event['yaxis.range']||[event['yaxis.range[0]'],event['yaxis.range[1]']];upper=Number(requested[1]??chart._fullLayout?.yaxis?.range?.[1]);}
      if(!Number.isFinite(upper)||upper<=0)upper=1;
      const rawMax=volumeMeta.compressed?(10**Math.min(upper,100)-1)*volumeMeta.unit:upper;
      const ticks=volumeTicks(rawMax,volumeMeta.compressed,volumeMeta.unit,volumeMeta.base);
      yClamp=true;Promise.resolve(Plotly.relayout(chart,{'yaxis.range':[0,upper],'yaxis.autorange':false,'yaxis.tickvals':ticks.tickvals,'yaxis.ticktext':ticks.ticktext})).finally(()=>{yClamp=false;});
    });chartEventsBound=true;}});
    latestRows=rows;
    renderTable();
    const funded=mode.normalized_orders.filter(r=>BigInt(r.allocated_sell_atoms)>0n).length,conditional=mode.normalized_orders.filter(r=>r.funding_status==='conditional').length;
    $('count').textContent=funded+' funded · '+mode.normalized_orders.length+' total';$('status').textContent=(symbol()+' ↔ '+($('market').value==='all'?'all major stables':data.metadata[$('market').value].symbol))+(pair().twap_only?' · TWAP schedules · limit book not indexed':' · '+funded+' allocated · '+conditional+' conditional orders excluded');
    $('fundingSummary').textContent=mode.funding_groups.length+' budgets · '+conditional+' conditional';$('checks').replaceChildren();for(const p of [['Verified limit orders in snapshot',data.verified_limit_orders],['Unbound / other classes excluded',data.classification_excluded],['Selected limit orders',mode.normalized_orders.length],['Fully allocated',mode.counts.fully_allocated||0],['Partially allocated',mode.counts.partially_allocated||0],['No allocation',mode.counts.not_allocated||0],['Conditional funding excluded',conditional],['Mode / scope exclusions',mode.excluded.length]])cells($('checks'),p);
    cells($('checks'),['Approval setup from unallocated orders',mode.approval_setup_from_unallocated_orders],'A verified original permit from an unallocated trade can grant approval for a selected owner/sell-token budget. This is approval setup, not a claim that every supporting order trades.');
    $('rates').replaceChildren();for(const[a,v]of Object.entries(mode.quote_usdc_equivalent_rates))cells($('rates'),[data.metadata[a].symbol,fmt(v,10)]);
    $('scope').textContent='USDC-normalized · '+(log?'zero-based compression':'linear depth')+' · '+($('dust').checked?'dust included':'orders ≥$1 displayed');$('volumeScale').title='Zero-based compression uses log10(1 + depth / unit), with unit $1 or its base-token reference equivalent. Zero remains exactly zero.';$('scope').title=data.scope;
  }
  function bindCompactHover(chart){
    let pending,down;
    const hide=()=>{$('ammHover').hidden=true;cancelAnimationFrame(pending);chart._depthHover=null;chart._twapHover=null;Plotly.Fx.unhover(chart);markBookOrder(null);};
    chart.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});
    chart.addEventListener('click',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<4){const row=twapHit(chart,e);if(row)showTwap(row.id);else if(chart._depthHover)showOrder(chart._depthHover);}down=null;});
    chart.addEventListener('pointerleave',hide);
    chart.addEventListener('pointermove',event=>{
      const layout=chart._fullLayout;if(!layout)return;
      const rect=chart.getBoundingClientRect(),axis=layout.xaxis,vertical=layout.yaxis;
      const x=event.clientX-rect.left-axis._offset,y=event.clientY-rect.top-vertical._offset;
      if(event.buttons||x<0||x>axis._length||y<0||y>vertical._length){hide();return;}
      const twap=twapHit(chart,event);if(twap){cancelAnimationFrame(pending);chart._depthHover=null;chart._twapHover=twap.id;markBookOrder(null);Plotly.Fx.unhover(chart);showTwapHover(twap,event);return;}chart._twapHover=null;$('ammHover').classList.remove('twap-hover');
      const marker=$('amm').checked?ammMarker():null;
      if(marker&&[marker.bid,marker.mid,marker.ask].some(price=>Math.abs(axis.d2p(price)-x)<=7)){
        cancelAnimationFrame(pending);chart._depthHover=null;markBookOrder(null);Plotly.Fx.unhover(chart);
        const description=ammDescription(marker),liquidity=Number(marker.liquidity_usd),hover=$('ammHover');
        hover.textContent=marker.venue+' · '+description.pair+'\nMid '+money(marker.mid)+' · '+description.feeLabel+'\nAMM bid '+money(marker.bid)+' · ask '+money(marker.ask)+(Number.isFinite(liquidity)&&liquidity>0?'\nPool liquidity $'+compact(liquidity):'')+(Number(marker.volume_24h_usd)>0?'\nSurveyed 24h volume $'+compact(Number(marker.volume_24h_usd)):'')+'\n'+short(marker.pool)+' · block '+Number(marker.block).toLocaleString()+'\n'+(marker.selection_caveat||'Activity-ranked verified pool')+'\n'+(description.curve?'≈$1 quotes incl. pool fees; geometric mid; no gas':'Spot, no gas or size impact');
        hover.hidden=false;hover.style.left=Math.max(8,Math.min(event.clientX+14,window.innerWidth-hover.offsetWidth-8))+'px';hover.style.top=Math.max(8,Math.min(event.clientY+14,window.innerHeight-hover.offsetHeight-8))+'px';return;
      }
      $('ammHover').hidden=true;
      let nearest=null;
      for(let curveNumber=0;curveNumber<chart.data.length;curveNumber++){
        const trace=chart.data[curveNumber];if(trace.visible==='legendonly'||trace.visible===false||trace.meta?.nominal||trace.meta?.twap)continue;
        for(let pointNumber=0;pointNumber<trace.x.length;pointNumber++){
          const distance=Math.abs(axis.d2p(trace.x[pointNumber])-x);
          if(!nearest||distance<nearest.distance)nearest={curveNumber,pointNumber,distance};
        }
      }
      cancelAnimationFrame(pending);
      if(nearest){chart._depthHover=chart.data[nearest.curveNumber].customdata[nearest.pointNumber][1];markBookOrder(chart._depthHover,true);pending=requestAnimationFrame(()=>Plotly.Fx.hover(chart,[{curveNumber:nearest.curveNumber,pointNumber:nearest.pointNumber}]));}else hide();
    },{passive:true});
  }
  function updateVisibleCount(bounds){const mode=current();const funded=mode.normalized_orders.filter(r=>BigInt(r.allocated_sell_atoms)>0n);const selected=funded.filter(r=>($('market').value==='all'||r.quote_token===$('market').value)&&($('dust').checked||Number(r.allocated_quote_atoms)/10**data.metadata[r.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[r.quote_token])>=1));const visible=selected.filter(r=>!bounds||(Number(r.normalized_price)>=Number(bounds[0])&&Number(r.normalized_price)<=Number(bounds[1])));$('visibleCount').textContent=pair().twap_only?twapRows().length+' scheduled TWAP'+(twapRows().length===1?'':'s')+' · limit book not indexed':visible.length+' displayed orders in view · '+funded.length+' funded in book · '+mode.normalized_orders.length+' total';}
  function orderLink(uid){const a=document.createElement('a');a.href='https://explorer.cow.fi/orders/'+uid;a.textContent='Explorer ↗';a.title='View order on CoW Explorer';a.target='_blank';a.rel='noopener noreferrer';a.addEventListener('click',e=>e.stopPropagation());return a;}
  function highlightOrder(uid){
    markBookOrder(uid);
    const chart=$('chart');if(!chart.layout||!chart._fullLayout)return;
    const shapes=(chart.layout.shapes||[]).filter(s=>!s.name?.startsWith('order-highlight'));
    const annotations=(chart.layout.annotations||[]).filter(a=>a.name!=='order-highlight');
    if(uid){const row=current().normalized_orders.find(r=>r.uid===uid);if(!row)return;
      const price=Number(row.normalized_price),axis=chart._fullLayout.xaxis,px=axis.d2p(price);
      const trace=chart.data.find(t=>!t.meta?.nominal&&t.customdata?.some(d=>d[1]===uid));
      const indices=trace?trace.customdata.map((d,i)=>d[1]===uid?i:-1).filter(i=>i>=0):[];
      const color=row.side==='bid'?'#a5f5ce':'#ffd2b5';
      if(px>=0&&px<=axis._length){
        shapes.push({name:'order-highlight-guide',type:'line',xref:'x',yref:'paper',x0:price,x1:price,y0:0,y1:1,line:{color,width:1,dash:'dot'}});
        if(indices.length){const first=indices[0],last=indices.at(-1);shapes.push({name:'order-highlight-segment',type:'line',xref:'x',yref:'y',x0:price,x1:price,y0:trace.y[first],y1:trace.y[last],line:{color,width:6}});shapes.push({name:'order-highlight-point',type:'circle',xref:'x',yref:'y',xsizemode:'pixel',ysizemode:'pixel',xanchor:price,yanchor:trace.y[last],x0:-5,x1:5,y0:-5,y1:5,fillcolor:color,line:{color:'#101013',width:1}});}
      }else annotations.push({name:'order-highlight',xref:'paper',yref:'paper',x:px<0?0:1,y:.95,text:(px<0?'← ':'')+money(price)+(px>=axis._length?' →':''),xanchor:px<0?'left':'right',showarrow:false,bgcolor:'#23232c',font:{color,size:12}});
    }
    Plotly.relayout(chart,{shapes,annotations});
  }
  function chartHeight(){return Math.max(260,$('chart').clientHeight||490);}
  function markBookOrder(uid,reveal=false){
    if(activeBookUid!==uid){for(const row of document.querySelectorAll('.book-row.is-highlighted'))row.classList.remove('is-highlighted');activeBookUid=uid;}
    if(!uid)return;const row=document.querySelector('.book-row[data-order="'+uid+'"]');if(!row)return;row.classList.add('is-highlighted');
    if(reveal){const pane=row.closest('.book-scroll'),r=row.getBoundingClientRect(),box=pane.getBoundingClientRect();if(r.top<box.top)pane.scrollTop-=box.top-r.top;else if(r.bottom>box.bottom)pane.scrollTop+=r.bottom-box.bottom;}
  }
  function renderTable(){
    const mode=current(),base=$('depth').value==='base';
    const bookRows=latestRows.filter(r=>($('showUnfunded').checked&&BigInt(r.allocated_sell_atoms)===0n)||$('dust').checked||Number(r.allocated_quote_atoms)/10**data.metadata[r.quote_token].decimals*Number(mode.quote_usdc_equivalent_rates[r.quote_token])>=1);
    const model=DfusionBook.buildBook(bookRows,{includeUnfunded:$('showUnfunded').checked,search:$('orderSearch').value,baseDecimals:pair().base_decimals,depthUnit:base?'base':'usd',metadata:data.metadata,quoteRates:mode.quote_usdc_equivalent_rates});
    const key=pair().id+'|'+$('market').value+'|'+$('depth').value+'|'+$('showUnfunded').checked+'|'+$('orderSearch').value+'|'+$('dust').checked;
    if(key!==bookView)bookResetPending=true;const frame=++bookFrame;
    const askBottom=$('asksScroll').scrollHeight-$('asksScroll').scrollTop-$('asksScroll').clientHeight,bidTop=$('bidsScroll').scrollTop;bookView=key;
    const nearDepth=Math.max(1,...model.asks.slice(-8).map(r=>r.total),...model.bids.slice(0,8).map(r=>r.total));
    const quantity=value=>base?fmt(value,Math.abs(value)<1?6:3):(value>=1000?'$'+compact(value):money(value));
    $('bookSizeLabel').textContent='Size · '+(base?symbol():'$');$('bookTotalLabel').textContent='Total · '+(base?symbol():'$');
    $('bookSizeLabel').title='Allocated order size';$('bookTotalLabel').title='Cumulative funded depth from best price; unchanged by search';
    for(const[side,values,target]of [['ask',model.asks,'askRows'],['bid',model.bids,'bidRows']]){
      $(target).replaceChildren();
      if(!values.length){const tr=cells($(target),[$('orderSearch').value?'No matching '+(side==='ask'?'asks':'bids'):'No '+(side==='ask'?'sell':'buy')+' orders']);tr.children[0].colSpan=3;tr.children[0].className='book-empty';continue;}
      for(const entry of values){const r=entry.order,tr=document.createElement('tr');tr.dataset.order=r.uid;tr.className='book-row '+(BigInt(r.allocated_sell_atoms)>0n?'':'unfunded');tr.style.setProperty('--depth-percent',Math.min(100,entry.total/nearDepth*100)+'%');tr.tabIndex=0;tr.setAttribute('aria-label',(side==='ask'?'Sell':'Buy')+' '+baseSymbol(r)+' at '+money(entry.price));
        const price=document.createElement('td');price.className='book-price';const line=document.createElement('span');line.textContent=money(entry.price);const explorer=orderLink(r.uid);explorer.textContent='↗';line.append(explorer);price.append(line);
        const meta=document.createElement('span');meta.className='book-meta';meta.textContent=baseSymbol(r)+'/'+r.quote_symbol+' · '+short(r.owner)+(BigInt(r.allocated_sell_atoms)===0n?' · '+(r.funding_status==='conditional'?'conditional':'unfunded'):r.funding_status==='partially_allocated'?' · partial':'');price.append(meta);tr.append(price);
        for(const[value,cls]of [[entry.size,'book-size'],[entry.total,'book-total']]){const cell=document.createElement('td');cell.className=cls;cell.textContent=quantity(value);cell.title=fmt(value,12)+' '+(base?symbol():'USDC-equivalent');tr.append(cell);}
        tr.addEventListener('mouseenter',()=>highlightOrder(r.uid));tr.addEventListener('mouseleave',()=>highlightOrder(null));tr.addEventListener('focus',()=>highlightOrder(r.uid));tr.addEventListener('blur',()=>highlightOrder(null));tr.addEventListener('click',()=>showOrder(r.uid));tr.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target===tr)showOrder(r.uid);});$(target).append(tr);
      }
    }
    $('bookMid').textContent=model.mid==null?'—':money(model.mid);$('bookMidLabel').textContent=model.midSource==='both'?'Midpoint':model.midSource==='bid'?'Best bid':model.midSource==='ask'?'Best ask':'No quotes';
    $('bookMid').title='Midpoint of funded reference-normalized bid and ask orders worth at least $1';
    $('bookSpread').textContent=model.bestBid!=null&&model.bestAsk!=null?fmt(Math.abs(model.bestAsk-model.bestBid)/model.mid*10000,1)+' bps'+(model.referenceOverlap?' · ref. overlap':model.bestBid>model.bestAsk?' · crossed':''):'—';
    $('bookReference').textContent=pair().reference_available===false?'Reference unavailable':'Ref '+money(pair().reference_usdc_equivalent);
    $('tableCount').textContent=' · '+(model.asks.length+model.bids.length)+($('orderSearch').value?' matching':' shown');
    if(bookResetPending){$('asksScroll').scrollTop=$('asksScroll').scrollHeight;$('bidsScroll').scrollTop=0;}
    requestAnimationFrame(()=>{if(frame!==bookFrame)return;$('asksScroll').scrollTop=bookResetPending?$('asksScroll').scrollHeight:Math.max(0,$('asksScroll').scrollHeight-$('asksScroll').clientHeight-askBottom);$('bidsScroll').scrollTop=bookResetPending?0:bidTop;bookResetPending=false;if(activeBookUid)markBookOrder(activeBookUid);});
  }
  function showOrder(uid){selectedTwap=null;$('takeOrder').hidden=false;$('detailTitle').textContent='Selected order';const r=current().normalized_orders.find(r=>r.uid===uid);if(!r)return;selectedUid=uid;$('orderDetail').hidden=false;$('detailContent').replaceChildren();for(const[label,value]of [['Side',(r.side==='ask'?'Sell ':'Buy ')+baseSymbol(r)],['Limit price',money(r.normalized_price)+' / '+symbol()],['Funded size',fmt(Number(r.allocated_base_atoms)/10**pair().base_decimals,7)+' '+symbol()],...(r.allocated_actual_base_atoms!=null?[['Original asset',baseSymbol(r)],['Original order size',fmt(Number(r.nominal_actual_base_atoms)/10**data.metadata[r.base_token].decimals,9)+' '+baseSymbol(r)],['Original funded size',fmt(Number(r.allocated_actual_base_atoms)/10**data.metadata[r.base_token].decimals,9)+' '+baseSymbol(r)],...(pair().conversions?[['Conversion',fmt(r.base_conversion,10)+' ETH / '+baseSymbol(r)]]:[])]:[]),['Quote',r.quote_symbol],['Funding',r.funding_status.replaceAll('_',' ')]]){const div=document.createElement('div');div.className='detail-field';const l=document.createElement('span');l.className='detail-label';l.textContent=label;div.append(l,document.createTextNode(value));$('detailContent').append(div);}const owner=document.createElement('div');owner.className='detail-field';const l=document.createElement('span');l.className='detail-label';l.textContent='Seller / order owner';const a=document.createElement('a');a.href='https://etherscan.io/address/'+r.owner;a.target='_blank';a.rel='noopener noreferrer';a.textContent=r.owner;owner.append(l,a);$('detailContent').append(owner);const id=document.createElement('div');id.className='detail-id';id.textContent='Order '+r.uid;id.append(document.createTextNode(' · '),orderLink(r.uid));$('detailContent').append(id);DfusionTakeUI.selectOrder(r,data.metadata);}
  function download(name,type,text){const u=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  function applySnapshot(next){
    const token=$('pair').value,quote=$('market').value,viewport=userViewport;
    applyingSnapshot=true;data=next;$('pair').replaceChildren();
    for(const p of data.pairs){const option=document.createElement('option');option.value=p.id;option.textContent=pairLabel(p);$('pair').append(option);}
    if(data.pairs.some(p=>p.id===token))$('pair').value=token;
    renderConversions();markets();if([...$('market').options].some(o=>o.value===quote))$('market').value=quote;else if(pair().default_quote)$('market').value=pair().default_quote;
    $('timestamp').textContent=new Date(data.as_of_timestamp*1000).toISOString().slice(0,19).replace('T',' ')+' UTC';$('auction').textContent=data.auction_id.toLocaleString();
    $('reference').textContent=pair().reference_available===false?'—':money(pair().reference_usdc_equivalent);
    $('reference').title=pair().reference_available===false?'Reference unavailable in latest auction':pair().reference_usdc_equivalent+' USDC-equivalent per '+pair().base_symbol;
    $('depth').querySelector('[value=base]').textContent=pair().base_symbol;
    render();if(selectedTwap){if(twapRows().some(row=>row.id===selectedTwap))showTwap(selectedTwap);else{selectedTwap=null;$('orderDetail').hidden=true;}}if(selectedUid){if(current().normalized_orders.some(r=>r.uid===selectedUid))showOrder(selectedUid);else{DfusionTakeUI.clearOrder();$('orderDetail').hidden=true;selectedUid=null;}}window.dfusionPairBook=data;window.dfusionEthBook=data;
    requestAnimationFrame(()=>{const done=()=>{applyingSnapshot=false;};if(viewport&&viewport.scale===$('scale').value){userViewport=viewport;Promise.resolve(Plotly.relayout('chart',{'xaxis.range':viewport.scale==='log'?viewport.range.map(Math.log10):viewport.range,'xaxis.autorange':false})).finally(done);}else done();});
  }
  async function pollSnapshot(){
    if(polling)return;polling=true;
    try{
      const response=await fetch('status.json',{cache:'no-store'});if(!response.ok)throw Error('status');const state=await response.json();
      const age=state.last_success==null?Infinity:Date.now()/1000-state.last_success;
      const stale=state.stale||age>state.refresh_seconds*2;
      $('freshness').textContent=state.refreshing?'Updating…':stale?'Update delayed':'Auto · 5 min';$('bookLiveStatus').textContent=state.refreshing?'Updating':stale?'Delayed':'Live';$('bookLiveStatus').parentElement.classList.toggle('warning',Boolean(stale));
      $('freshness').title=state.last_success?'Last successful refresh '+new Date(state.last_success*1000).toISOString().replace('T',' ').slice(0,19)+' UTC'+(state.last_error?' · last refresh failed':''):'Waiting for a complete snapshot';
      $('freshness').classList.toggle('warning',Boolean(stale));
      if(state.snapshot_id&&state.snapshot_id!==lastSnapshotId){const r=await fetch('dfusion-eth-book.json?v='+encodeURIComponent(state.snapshot_id),{cache:'no-store'});if(!r.ok)throw Error('snapshot');const next=await r.json();applySnapshot(next);lastSnapshotId=state.snapshot_id;}
    }catch{ $('bookLiveStatus').textContent='Cached';$('bookLiveStatus').parentElement.classList.add('warning');$('freshness').textContent='Connection delayed';$('freshness').classList.add('warning');}
    finally{polling=false;}
  }
  async function requestFreshSnapshot(){
    try{
      const response=await fetch('refresh',{method:'POST',cache:'no-store'});
      if(response.ok){$('freshness').textContent='Refresh requested';$('freshness').title='Reload requested a shared server refresh. Cached data stays visible until the next complete snapshot.';}
      else if(response.status!==429)throw Error('refresh');
    }catch{$('freshness').title='Automatic refresh is still enabled; reload refresh request could not be sent.';}
  }
  async function initialSnapshot(){
    for(;;){
      try{const response=await fetch('dfusion-eth-book.json',{cache:'no-store'});if(response.ok)return await response.json();}
      catch{}
      $('status').textContent='Waiting for the first complete snapshot…';
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
  }
  async function start(){const refreshRequest=requestFreshSnapshot();data=await initialSnapshot();$('timestamp').textContent=new Date(data.as_of_timestamp*1000).toISOString().slice(0,19).replace('T',' ')+' UTC';$('auction').textContent=data.auction_id.toLocaleString();for(const p of data.pairs){const o=document.createElement('option');o.value=p.id;o.textContent=pairLabel(p);$('pair').append(o);}const params=new URLSearchParams(location.search);const requested=params.get('token')||(params.get('pair')||'').split('-')[0];const requestedQuote=params.get('quote');if(data.pairs.some(p=>p.id===requested))$('pair').value=requested;$('pair').addEventListener('change',selectPair);selectPair();if(requestedQuote){const q=Object.keys(pair().quote_modes).find(a=>data.metadata[a].symbol.toLowerCase()===requestedQuote.toLowerCase());if(q)$('market').value=q;}$('market').addEventListener('change',()=>{resetSelection();render();updateURL();});$('showUnfunded').addEventListener('change',()=>{bookView=null;highlightOrder(null);renderTable();});$('orderSearch').addEventListener('input',()=>{bookView=null;renderTable();});$('twapSelect').addEventListener('change',()=>{if($('twapSelect').value)showTwap($('twapSelect').value);});$('closeDetail').addEventListener('click',()=>{selectedTwap=null;$('twapSelect').value='';DfusionTakeUI.clearOrder();$('orderDetail').hidden=true;selectedUid=null;});for(const id of ['depth','volumeScale','scale','window','nominal','dust','amm','twaps'])$(id).addEventListener('change',()=>{if(id==='window'||id==='scale')userViewport=null;render({preserveViewport:id==='amm'});});
    $('json').addEventListener('click',()=>download('dfusion-pair-limit-funding.json','application/json',JSON.stringify(data,null,2)));$('svg').addEventListener('click',()=>Plotly.downloadImage('chart',{format:'svg',filename:'dfusion-pair-limit-depth'}));$('csv').addEventListener('click',()=>{const fields=['uid','owner','side','base_token','quote_symbol','kind','normalized_price','remaining_sell_atoms','remaining_buy_atoms','allocated_sell_atoms','allocated_base_atoms','allocated_quote_atoms','nominal_actual_base_atoms','allocated_actual_base_atoms','base_conversion','funding_status'];const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};download('dfusion-pair-limit-orders.csv','text/csv',[fields,...latestRows.map(r=>fields.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n'));});let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if($('chart').data){const mobile=window.innerWidth<600,ref=Number(pair().reference_usdc_equivalent),annotations=($('chart').layout.annotations||[]).map(a=>a.text?.startsWith('Reference ')?{...a,xref:mobile?'paper':'x',x:mobile?1:($('scale').value==='log'?Math.log10(ref):ref),y:mobile?.98:1.02}:a);Plotly.relayout('chart',{'xaxis.nticks':mobile?3:8,height:chartHeight(),'margin.l':mobile?55:70,annotations});}},150);});window.dfusionEthBook=data;window.dfusionPairBook=data;render();updateURL();await refreshRequest;await pollSnapshot();setInterval(pollSnapshot,5000);}

  start().catch(()=>{$('status').textContent='Limit-order snapshot could not load. Reload this page.';$('status').classList.add('warning');});
})();
